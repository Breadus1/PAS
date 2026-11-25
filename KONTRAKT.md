# Kontrakt wewnętrzny – etap III

Umowa między kartami: model danych, adresy stron, dane przekazywane między ekranami, sposób zapisu płatności i punktów. Publiczne API jest zgodne z kontraktem od CEO.

## Model danych

### Seans (`events.js`, stałe dane w kodzie)

| Pole | Typ | Opis |
|---|---|---|
| `_id` | tekst | np. `seans-2026-11-21-1800` |
| `title` | tekst | tytuł filmu |
| `startsAt` | tekst ISO | data i godzina seansu |
| `hall` | tekst | `Sala 1`, `Sala 2` |
| `price` | liczba | cena fotela w groszach, `3200` = 32 zł |
| `seats` | lista tekstów | `A1` … `H10`, 8 rzędów × 10 foteli |

### Rezerwacja (tabela `reservations` w Postgres)

| Kolumna | Typ | Opis |
|---|---|---|
| `id` | tekst (UUID) | id rezerwacji |
| `event_id`, `seat_id` | tekst | seans i fotel |
| `customer_name`, `email` | tekst | dane klienta |
| `amount` | liczba | cena w groszach zapisana w chwili rezerwacji, potem się nie zmienia |
| `expires_at` | czas | koniec ważności: chwila rezerwacji + `RESERVATION_MINUTES` |
| `status` | `held` / `paid` | `paid` ustawia tylko webhook |
| `code` | tekst / `null` | kod biletu, 8 znaków, nadawany przy zapłacie |
| `checkout_url` | tekst / `null` | adres jedynej sesji Stripe Checkout tej rezerwacji |
| `points_used` | liczba | punkty wydane przy płatności, ustalane raz przy pierwszym checkoucie |
| `points_earned` | liczba / `null` | punkty za zakup, liczone przy zapłacie |
| `points_awarded` | tak / nie | punkty za zakup dopisane w Voucherify |
| `points_returned` | tak / nie | punkty z wygasłej rezerwacji oddane w Voucherify |
| `email_sent`, `email_attempts` | tak / nie, liczba | mail z biletem wysłany; liczba prób (najwyżej 5) |

### Karta lojalnościowa (tabela `loyalty_members`)

| Kolumna | Opis |
|---|---|
| `email` | e-mail klienta małymi literami, identyfikator klienta w Voucherify (`source_id`) |
| `member_id` | kod karty lojalnościowej w Voucherify |

Tabela tylko zapamiętuje numer karty, żeby nie pytać o niego Voucherify. **Saldo punktów trzymamy wyłącznie w Voucherify** – to źródło prawdy, z którego korzysta też marketing.

**Fotel jest zajęty**, gdy istnieje rezerwacja z `status = paid` albo z `expires_at > teraz`.
**Status w API** `expired` nie jest zapisywany, tylko wyliczany: `held` i `expires_at <= teraz`.

## API i odpowiedzi

| Endpoint | Sukces | Odmowa |
|---|---|---|
| `GET /api/events` | 200 lista seansów | – |
| `GET /api/events/:id` | 200 `{ event, takenSeats }` | 404 brak seansu |
| `POST /api/reservations` | 201 `{ reservationId, expiresAt, amount }`; 200 ta sama rezerwacja przy powtórzeniu z tymi samymi danymi | 400 zły fotel / imię / e-mail, 404 brak seansu, 409 fotel zajęty, 429 limit + `Retry-After` |
| `GET /api/reservations/:id` | 200 `{ reservationId, status, amount, expiresAt, eventId, seatId, email, code?, pointsUsed, pointsEarned? }` | 404 |
| `POST /api/reservations/:id/checkout` z opcjonalnym `{ points }` | 200 `{ url }`, sesja na `amount − points` | 400 złe punkty / ponad połowę ceny / za mało punktów, 404, 409 już opłacona albo inne punkty niż przy pierwszym checkoucie, 410 wygasła, 503 Stripe albo Voucherify niedostępny |
| `GET /api/loyalty?email=…` | 200 `{ email, points }`; e-mail bez karty ma 1000 punktów | 400 zły e-mail, 429 limit, 503 Voucherify niedostępny |
| `POST /api/webhooks/stripe` | 200 | 400 zły podpis; 500 nieudany zwrot (Stripe ponowi) |

Limity: 30 rezerwacji na 10 s i 20 zapytań o saldo na minutę na adres IP.

## Strony i dane między ekranami

Między ekranami przekazujemy tylko identyfikatory w adresie. Resztę każda strona pobiera z API.

| Strona | Co robi | Dokąd prowadzi |
|---|---|---|
| `/` | repertuar z ceną | `/events/:eventId` |
| `/events/:id` | mapa sali, zajęte fotele szare | klik w wolny fotel: `/reserve?eventId=…&seatId=…` |
| `/reserve?eventId=…&seatId=…` | formularz: imię, e-mail; po wpisaniu e-maila saldo punktów | po rezerwacji: `/reservations/:reservationId` |
| `/reservations/:id` | licznik czasu, pole „Użyj punktów” z podpowiedzią, przycisk „Zapłać 22 zł” z kwotą do dopłaty | adres strony płatności Stripe |
| `/reservations/:id?payment=success` | strona powrotu po zapłacie: „czekamy na potwierdzenie”, co 2 s sprawdza status, potem bilet | – |
| `/reservations/:id?payment=cancelled` | strona powrotu po przerwaniu: licznik i ponowna płatność, dopóki rezerwacja ważna | – |
| bilet (ta sama strona, status `paid`) | kod biletu i podsumowanie: ile kartą, ile punktami, ile punktów zebrał | – |

## Zapis płatności i punktów

1. **Checkout:** w jednej transakcji blokujemy wiersz rezerwacji. Jeśli sesja już jest, oddajemy jej adres. Jeśli nie:
   - sprawdzamy `points`: liczba całkowita, najwyżej połowa `amount`;
   - przy `points > 0` blokujemy klienta, sprawdzamy saldo w Voucherify i od razu odejmujemy punkty (`POST /v1/loyalties/members/{kod}/balance` z ujemnym `points`); nowy klient dostaje kartę z 1000 punktami;
   - tworzymy sesję Stripe na `amount − points` z `client_reference_id` = id rezerwacji; gdy Stripe zawiedzie, punkty wracają;
   - zapisujemy `points_used` i `checkout_url`.
2. **Webhook** (`checkout.session.completed`, `checkout.session.async_payment_succeeded`, podpis przez `constructEvent`), pod blokadą fotela i wiersza:
   - rezerwacja już opłacona: nic się nie zmienia;
   - rezerwacja ważna: `status = paid`, nowy kod biletu, `points_earned` = 10 × pełne złote zapłacone kartą; potem dopisanie punktów w Voucherify i mail z biletem;
   - rezerwacja wygasła: bez biletu, zwrot pieniędzy w Stripe (klucz idempotencji `refund-<id sesji>`) i zwrot wydanych punktów.
3. Webhook do nieznanej rezerwacji jest pomijany (odpowiedź 200).
4. **Sprzątacz** co 5 s kończy zaległe sprawy: oddaje punkty z wygasłych nieopłaconych rezerwacji, dopisuje niedopisane punkty za zakup i wysyła niewysłane maile. Każdą sprawę najpierw „zajmuje” atomową zmianą flagi w bazie, więc nic nie wykona się dwa razy, nawet przy kilku serwerach. Po błędzie usługi czeka minutę, żeby nie zużywać limitu.

Przykład dla nowego klienta: cena 3200, wydaje 1000 punktów, płaci kartą 2200 (22 zł), zbiera 220 punktów, saldo po zakupie 220.

## Konfiguracja

Zmienne środowiskowe na serwerze (Render): `DATABASE_URL`, `RESERVATION_MINUTES` (w testach 2), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `VOUCHERIFY_APP_ID`, `VOUCHERIFY_SECRET_KEY`, `VOUCHERIFY_CAMPAIGN_ID`, `VOUCHERIFY_API_URL`, `RESEND_API_KEY`, opcjonalnie `EMAIL_FROM`. Kluczy nie ma w repozytorium ani w przeglądarce.

## Karty etapu III

| Karta | Zakres | Gdzie w kodzie |
|---|---|---|
| A. Punkty za zakupy | `GET /api/loyalty`, saldo w formularzu, punkty powitalne i za zakup | `loyalty.js`, `server.js` (`/api/loyalty`, `awardPoints`), `reserve.html` |
| B. Płatność punktami | `points` w checkoucie, pole „Użyj punktów”, kwota do dopłaty na przycisku | `server.js` (`/checkout`), `loyalty.js` (`spendPoints`), `reservation.html` |
| C. Potwierdzenie zakupu | mail z biletem i podsumowaniem, podsumowanie na bilecie, `pointsUsed` i `pointsEarned` | `mail.js`, `server.js` (`sendTicketEmail`), `reservation.html` |
| Z listy zagrożeń | dane w bazie zamiast w pamięci, zwrot punktów po wygaśnięciu, ponawianie po awariach, oszczędzanie limitu Voucherify, skrypt ataku | `db.js`, `server.js` (`settle`, `returnPoints`), `atak.js`, `ZAGROZENIA.md` |
