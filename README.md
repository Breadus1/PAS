# KinoBilet

Kasa biletowa kina (PAS S01). Klient wybiera seans i fotel, rezerwuje go na 15 minut, płaci kartą przez Stripe Checkout i dostaje bilet z kodem.

## Uruchomienie

```
npm install
npm start
```

Strona: http://localhost:3000

## Zmienne środowiskowe

| Zmienna | Opis |
|---|---|
| `RESERVATION_MINUTES` | czas ważności rezerwacji, domyślnie 15, w testach 2 |
| `STRIPE_SECRET_KEY` | klucz testowy Stripe (`sk_test_…`) |
| `STRIPE_WEBHOOK_SECRET` | sekret podpisu webhooka (`whsec_…`) |

Klucze są tylko w zmiennych środowiskowych na serwerze, nigdy w repozytorium.

W PowerShellu: `$env:RESERVATION_MINUTES=2; npm start`

## API

| Metoda | Adres | Odpowiedź |
|---|---|---|
| GET | `/api/events` | lista seansów z `price` w groszach |
| GET | `/api/events/:id` | `{ event, takenSeats }` |
| POST | `/api/reservations` | `{ reservationId, expiresAt, amount }` |
| GET | `/api/reservations/:id` | `{ status, amount, expiresAt, code? }`, status: `held`, `paid`, `expired` |
| POST | `/api/reservations/:id/checkout` | `{ url }` strony płatności Stripe |
| POST | `/api/webhooks/stripe` | zdarzenia od Stripe, m.in. `checkout.session.completed` |

Body rezerwacji: `{ eventId, seatId, customerName, email }`, np. `seatId: "F7"`.

## Strony

- `/` – repertuar
- `/events/:id` – mapa sali
- `/reserve?eventId=…&seatId=…` – formularz rezerwacji
- `/reservations/:id` – licznik czasu i przycisk „Zapłać”
- `/reservations/:id?payment=success` – powrót po zapłacie: „płatność w toku…”, potem bilet
- `/reservations/:id?payment=cancelled` – powrót po przerwaniu, można zapłacić ponownie

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
