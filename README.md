# KinoBilet

Kasa biletowa kina (PAS S01). Klient wybiera seans i fotel, rezerwuje go na 15 minut, płaci kartą przez Stripe Checkout (część ceny może zapłacić punktami z programu lojalnościowego w Voucherify) i dostaje bilet z kodem, także mailem przez Resend. Dane są w bazie Postgres.

**Wdrożenie:** https://kinobilet.onrender.com (Render, tryb testowy: rezerwacja na 2 minuty). Darmowy serwer usypia po 15 minutach bez ruchu, więc pierwsze zapytanie po przerwie trwa około minuty.

## Uruchomienie

Potrzebna jest baza Postgres, lokalnie np. w Dockerze:

```
docker run -d --name kino-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=kino -p 5432:5432 postgres:16-alpine
```

```
npm install
DATABASE_URL=postgres://postgres:test@localhost:5432/kino npm start
```

Strona: http://localhost:3000

## Zmienne środowiskowe

| Zmienna | Opis |
|---|---|
| `DATABASE_URL` | adres bazy Postgres (np. Neon), wymagany; tabele zakładają się same przy starcie |
| `RESERVATION_MINUTES` | czas ważności rezerwacji, domyślnie 15, w testach 2 |
| `STRIPE_SECRET_KEY` | klucz testowy Stripe (`sk_test_…`) |
| `STRIPE_WEBHOOK_SECRET` | sekret podpisu webhooka (`whsec_…`) |
| `VOUCHERIFY_APP_ID`, `VOUCHERIFY_SECRET_KEY` | klucze projektu Sandbox w Voucherify (Project settings → Application keys) |
| `VOUCHERIFY_CAMPAIGN_ID` | id kampanii lojalnościowej (`camp_…`) |
| `VOUCHERIFY_API_URL` | adres API Voucherify, domyślnie `https://api.voucherify.io` (inny klaster np. `https://us1.api.voucherify.io`) |
| `RESEND_API_KEY` | klucz Resend (`re_…`) do maili z biletem |
| `EMAIL_FROM` | nadawca maili, domyślnie `KinoBilet <onboarding@resend.dev>` |

Klucze są tylko w zmiennych środowiskowych na serwerze, nigdy w repozytorium.

W PowerShellu: `$env:DATABASE_URL="postgres://postgres:test@localhost:5432/kino"; $env:RESERVATION_MINUTES=2; npm start`

## API

| Metoda | Adres | Odpowiedź |
|---|---|---|
| GET | `/api/events` | lista seansów z `price` w groszach |
| GET | `/api/events/:id` | `{ event, takenSeats }` |
| POST | `/api/reservations` | `{ reservationId, expiresAt, amount }` |
| GET | `/api/reservations/:id` | `{ status, amount, expiresAt, code?, pointsUsed, pointsEarned? }`, status: `held`, `paid`, `expired` |
| POST | `/api/reservations/:id/checkout` | body opcjonalnie `{ points }`; `{ url }` strony płatności Stripe na `amount − points` |
| POST | `/api/webhooks/stripe` | zdarzenia od Stripe, m.in. `checkout.session.completed` |
| GET | `/api/loyalty?email=…` | `{ email, points }`, saldo z Voucherify; nowy klient ma 1000 punktów |

Body rezerwacji: `{ eventId, seatId, customerName, email }`, np. `seatId: "F7"`.

## Strony

- `/` – repertuar
- `/events/:id` – mapa sali
- `/reserve?eventId=…&seatId=…` – formularz rezerwacji, po wpisaniu e-maila saldo punktów
- `/reservations/:id` – licznik czasu, pole „Użyj punktów” i przycisk „Zapłać” z kwotą do dopłaty
- `/reservations/:id?payment=success` – powrót po zapłacie: „czekamy na potwierdzenie”, potem bilet z podsumowaniem
- `/reservations/:id?payment=cancelled` – powrót po przerwaniu, można zapłacić ponownie

## Program lojalnościowy

- Nowy klient (e-mail) ma 1000 punktów, 1 punkt = 1 grosz.
- Punktami można zapłacić do połowy ceny, resztę kartą.
- Za każdy pełny złoty zapłacony kartą klient dostaje 10 punktów.
- Saldo trzyma Voucherify (kampania lojalnościowa w projekcie Sandbox, klient = e-mail jako `source_id`).
- Punkty wydane na rezerwację, która wygasła bez zapłaty, wracają same w ciągu kilku sekund.
- Sandbox Voucherify przyjmuje 100 wywołań na godzinę; pełny `atak.js` zużywa około 20.

Mail z biletem wysyła Resend. Bez własnej domeny tylko na adres właściciela konta i adresy testowe, np. `delivered+jan@resend.dev`.

## Stripe lokalnie

```
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

Karty testowe: `4242 4242 4242 4242` (udana), `4000 0000 0000 0002` (odmowa), `4000 0025 0000 3155` (3D Secure). Data ważności dowolna w przyszłości, CVC dowolne.

## Sprawdzenie kryteriów

```
node atak.js http://localhost:3000
```

Z sekretem webhooka skrypt sprawdza też płatności: `STRIPE_WEBHOOK_SECRET=whsec_… node atak.js <adres>`.
