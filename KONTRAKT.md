# Kontrakt wewnętrzny – etap II

Umowa między kartami: model danych, adresy stron, dane przekazywane między ekranami i sposób zapisu płatności. Publiczne API jest zgodne z kontraktem od CEO.

## Model danych

### Seans (`events.js`)

| Pole | Typ | Opis |
|---|---|---|
| `_id` | tekst | np. `seans-2026-11-21-1800` |
| `title` | tekst | tytuł filmu |
| `startsAt` | tekst ISO | data i godzina seansu |
| `hall` | tekst | `Sala 1`, `Sala 2` |
| `price` | liczba | cena fotela w groszach, `3200` = 32 zł |
| `seats` | lista tekstów | `A1` … `H10`, 8 rzędów × 10 foteli |

### Rezerwacja (tablica w pamięci serwera)

| Pole | Typ | Opis |
|---|---|---|
| `_id` | UUID | id rezerwacji |
| `eventId`, `seatId` | tekst | seans i fotel |
| `customerName`, `email` | tekst | dane klienta |
| `amount` | liczba | cena w groszach zapisana w chwili rezerwacji, potem się nie zmienia |
| `expiresAt` | liczba (ms) | koniec ważności: chwila rezerwacji + `RESERVATION_MINUTES` |
| `status` | `held` / `paid` | `paid` ustawia tylko webhook |
| `code` | tekst / `null` | kod biletu, 8 znaków, nadawany przy zapłacie |
| `checkout` | obietnica sesji Stripe | wewnętrzne, jedna sesja na rezerwację |

**Fotel jest zajęty**, gdy istnieje rezerwacja z `status = paid` albo z `expiresAt > teraz`.
**Status w API** `expired` nie jest zapisywany, tylko wyliczany: `held` i `expiresAt <= teraz`.

## API i odpowiedzi

| Endpoint | Sukces | Odmowa |
|---|---|---|
| `GET /api/events` | 200 lista seansów | – |
| `GET /api/events/:id` | 200 `{ event, takenSeats }` | 404 brak seansu |
| `POST /api/reservations` | 201 `{ reservationId, expiresAt, amount }`; 200 ta sama rezerwacja przy powtórzeniu z tymi samymi danymi | 400 zły fotel / imię / e-mail, 404 brak seansu, 409 fotel zajęty, 429 limit + `Retry-After` |
| `GET /api/reservations/:id` | 200 `{ reservationId, status, amount, expiresAt, eventId, seatId, code? }` | 404 |
| `POST /api/reservations/:id/checkout` | 200 `{ url }` | 404 brak rezerwacji, 409 już opłacona, 410 wygasła, 503 Stripe niedostępny |
| `POST /api/webhooks/stripe` | 200 | 400 zły podpis; 500 nieudany zwrot (Stripe ponowi) |

Limit rezerwacji: 30 na 10 s na adres IP.

## Strony i dane między ekranami

Między ekranami przekazujemy tylko identyfikatory w adresie. Resztę każda strona pobiera z API.

| Strona | Co robi | Dokąd prowadzi |
|---|---|---|
| `/` | repertuar z ceną | `/events/:eventId` |
| `/events/:id` | mapa sali, zajęte fotele szare | klik w wolny fotel: `/reserve?eventId=…&seatId=…` |
| `/reserve?eventId=…&seatId=…` | formularz: imię, e-mail | po rezerwacji: `/reservations/:reservationId` |
| `/reservations/:id` | licznik czasu, przycisk „Zapłać 32 zł” | adres strony płatności Stripe |
| `/reservations/:id?payment=success` | strona powrotu po zapłacie: „Płatność w toku…”, co 2 s sprawdza status, potem bilet z kodem | – |
| `/reservations/:id?payment=cancelled` | strona powrotu po przerwaniu: licznik i ponowna płatność, dopóki rezerwacja ważna | – |

## Zapis płatności

1. **Checkout:** serwer tworzy jedną sesję Stripe Checkout na rezerwację. `client_reference_id` = id rezerwacji, kwota = `amount` z rezerwacji, waluta PLN. Kolejne kliknięcia „Zapłać” dostają tę samą sesję.
2. **Webhook:** obsługujemy `checkout.session.completed` i `checkout.session.async_payment_succeeded`. Podpis jest sprawdzany przez `stripe.webhooks.constructEvent`. Gdy `payment_status = paid`:
   - rezerwacja już opłacona: nic się nie zmienia, kod zostaje ten sam;
   - rezerwacja ważna: `status = paid` i nowy kod biletu;
   - rezerwacja wygasła: bez biletu, zwrot pieniędzy w Stripe (klucz idempotencji `refund-<id sesji>`).
3. Webhook do nieznanej rezerwacji jest pomijany (odpowiedź 200).

## Konfiguracja

Zmienne środowiskowe na serwerze (Render): `RESERVATION_MINUTES` (w testach 2), `STRIPE_SECRET_KEY` (`sk_test_…`), `STRIPE_WEBHOOK_SECRET` (`whsec_…`). Kluczy nie ma w repozytorium ani w przeglądarce.

## Karty etapu II

| Karta | Zakres | Gdzie w kodzie |
|---|---|---|
| A. Checkout | `price`, `amount`, `POST /checkout`, przycisk „Zapłać” | `events.js`, `server.js` (`createCheckoutSession`), `reservation.html` |
| B. Webhook | weryfikacja podpisu, oznaczenie jako opłacona, kod biletu | `server.js` (`/api/webhooks/stripe`, `handlePayment`) |
| C. Powrót do sklepu | `GET /api/reservations/:id`, strony powrotu | `server.js`, `reservation.html` |
| Z listy zagrożeń | zwrot przy płatności po czasie, jedna sesja na rezerwację, skrypt ataku | `server.js`, `atak.js`, `ZAGROZENIA.md` |
