# Kontrakt wewnętrzny – etap IV

Umowa między kartami: model danych, adresy stron, dane przekazywane między ekranami, sposób zapisu płatności i punktów oraz działanie listy oczekujących. Publiczne API jest zgodne z kontraktem od CEO.

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

### Lista oczekujących (tabela `waitlist`)

| Kolumna | Opis |
|---|---|
| `id` | UUID, `waitlistId` w API |
| `seq` | rosnący numer zapisu, wyznacza kolejność w kolejce |
| `event_id`, `email`, `customer_name` | seans i dane klienta (e-mail małymi literami) |
| `status` | zapisane: `waiting`, `offered`, `missed` (mail nie doszedł), `left` |
| `reservation_id` | rezerwacja założona dla tej osoby, gdy dostała miejsce |
| `email_sent`, `email_id` | mail z ofertą wysłany; id maila w Resend (po nim webhook rozpoznaje odbity mail) |

Status w API dla wpisu `offered` wynika z rezerwacji: opłacona → `done`, wygasła → `missed`, ważna → `offered`. `position` (od 1) liczymy przy odczycie: ile wpisów `waiting` tego seansu ma `seq` mniejszy lub równy.

Tabela `loyalty_members` tylko zapamiętuje numer karty, żeby nie pytać o niego Voucherify. **Saldo punktów trzymamy wyłącznie w Voucherify** – to źródło prawdy, z którego korzysta też marketing.

**Fotel jest zajęty**, gdy istnieje rezerwacja z `status = paid` albo z `expires_at > teraz`.
**Status w API** `expired` nie jest zapisywany, tylko wyliczany: `held` i `expires_at <= teraz`.

## API i odpowiedzi

| Endpoint | Sukces | Odmowa |
|---|---|---|
| `GET /api/events` | 200 lista seansów | – |
| `GET /api/events/:id` | 200 `{ event, takenSeats, soldOut }` | 404 brak seansu |
| `POST /api/reservations` | 201 `{ reservationId, expiresAt, amount }`; 200 ta sama rezerwacja przy powtórzeniu z tymi samymi danymi | 400 zły fotel / imię / e-mail, 404 brak seansu, 409 fotel zajęty, 429 limit + `Retry-After` |
| `GET /api/reservations/:id` | 200 `{ reservationId, status, amount, expiresAt, eventId, seatId, email, code?, pointsUsed, pointsEarned? }` | 404 |
| `POST /api/reservations/:id/checkout` z opcjonalnym `{ points }` | 200 `{ url }`, sesja na `amount − points` | 400 złe punkty / ponad połowę ceny / za mało punktów, 404, 409 już opłacona albo inne punkty niż przy pierwszym checkoucie, 410 wygasła, 503 Stripe albo Voucherify niedostępny |
| `GET /api/loyalty?email=…` | 200 `{ email, points }`; e-mail bez karty ma 1000 punktów | 400 zły e-mail, 429 limit, 503 Voucherify niedostępny |
| `POST /api/webhooks/stripe` | 200 | 400 zły podpis; 500 nieudany zwrot (Stripe ponowi) |
| `POST /api/events/:id/waitlist` z `{ email, customerName }` | 201 `{ waitlistId, position, status, eventId }`; 200 ten sam wpis przy ponownym zapisie tym samym e-mailem | 400 złe dane, 404 brak seansu, 409 seans nie jest wyprzedany (i nikt nie czeka), 429 limit |
| `GET /api/waitlist/:id` | 200 `{ waitlistId, eventId, status, position, reservationId?, offerExpiresAt? }` | 404 |
| `DELETE /api/waitlist/:id` | 200 stan wpisu (`left`, albo bez zmian dla `missed`) | 404, 409 bilet już kupiony |
| `POST /api/webhooks/resend` | 200 | 400 zły podpis Svix |

`POST /api/reservations` dodatkowo: 409, gdy na ten seans ktoś czeka w kolejce (zwolnione miejsca dostaje kolejka).

Limity: 30 rezerwacji na 10 s, 30 zapisów na listę na 10 s i 20 zapytań o saldo na minutę na adres IP. Saldo pamiętamy 10 s (czyszczone po każdej naszej zmianie punktów).

## Strony i dane między ekranami

Między ekranami przekazujemy tylko identyfikatory w adresie. Resztę każda strona pobiera z API.

| Strona | Co robi | Dokąd prowadzi |
|---|---|---|
| `/` | repertuar z ceną | `/events/:eventId` |
| `/events/:id` | mapa sali, zajęte fotele szare; na wyprzedanym seansie formularz „Powiadom mnie” | klik w wolny fotel: `/reserve?eventId=…&seatId=…`; po zapisie: `/waitlist/:waitlistId` |
| `/waitlist/:id` | miejsce w kolejce i „Wypisz mnie”; po zwolnieniu miejsca godzina, do której czeka, i link do zapłaty; co 3 s sprawdza status | `/reservations/:reservationId` |
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

## Lista oczekujących: jak karty dają sobie znać

Karty komunikują się wyłącznie przez bazę (tabele `waitlist` i `reservations`), nie wołają się nawzajem bezpośrednio.

1. **A → B:** karta A zapisuje wpis `waiting` (tylko na wyprzedanym seansie albo gdy kolejka już istnieje).
2. **B: przydział miejsca.** Sprzątacz co 5 s (oraz od razu po wypisaniu osoby z ofertą i po odbitym mailu) woła `offerFreeSeats` dla seansów z kolejką. Pod blokadą listy seansu paruje wolne fotele z kolejnymi wpisami `waiting`, zakłada dla każdej osoby zwykłą rezerwację z etapu I (`expires_at` = teraz + `RESERVATION_MINUTES`) i ustawia wpis na `offered` z `reservation_id`.
3. **B → C: ktoś dostał miejsce.** Sygnałem dla karty C jest wpis `offered` z `email_sent = false`. Karta C zajmuje go atomowo (`email_sent = true`), wysyła mail przez Resend (nazwa seansu, miejsce, link `/reservations/:id`, godzina, do której miejsce czeka) i zapisuje `email_id`. Przy błędzie flaga wraca na `false` i sprzątacz ponawia, dopóki oferta jest ważna.
4. **C → B: mail nie doszedł.** Webhook Resenda `email.bounced` (albo `email.failed`) z poprawnym podpisem: po `email_id` znajdujemy wpis, ustawiamy `missed`, a jego rezerwację zwalniamy od razu (`expires_at` = teraz). To jest sygnał dla karty B: fotel jest wolny, więc `offerFreeSeats` daje go następnej osobie.
5. **Niezapłacona oferta:** rezerwacja wygasa jak każda inna, API pokazuje `missed`, a fotel wraca do puli, z której karta B bierze go dla następnej osoby. Wydane punkty wracają przez sprzątacza (etap III).
6. **Zapłacona oferta:** zwykły webhook Stripe'a z etapu II; API pokazuje `done`. Płatność punktami działa tak samo jak przy każdej rezerwacji.

## Konfiguracja

Zmienne środowiskowe na serwerze (Render): `DATABASE_URL`, `RESERVATION_MINUTES` (w testach 2), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `VOUCHERIFY_APP_ID`, `VOUCHERIFY_SECRET_KEY`, `VOUCHERIFY_CAMPAIGN_ID`, `VOUCHERIFY_API_URL`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, opcjonalnie `EMAIL_FROM` i `APP_URL` (adres w linkach z maili, na Renderze domyślnie `RENDER_EXTERNAL_URL`). Kluczy nie ma w repozytorium ani w przeglądarce.

## Karty etapu III

| Karta | Zakres | Gdzie w kodzie |
|---|---|---|
| A. Punkty za zakupy | `GET /api/loyalty`, saldo w formularzu, punkty powitalne i za zakup | `loyalty.js`, `server.js` (`/api/loyalty`, `awardPoints`), `reserve.html` |
| B. Płatność punktami | `points` w checkoucie, pole „Użyj punktów”, kwota do dopłaty na przycisku | `server.js` (`/checkout`), `loyalty.js` (`spendPoints`), `reservation.html` |
| C. Potwierdzenie zakupu | mail z biletem i podsumowaniem, podsumowanie na bilecie, `pointsUsed` i `pointsEarned` | `mail.js`, `server.js` (`sendTicketEmail`), `reservation.html` |
| Z listy zagrożeń | dane w bazie zamiast w pamięci, zwrot punktów po wygaśnięciu, ponawianie po awariach, oszczędzanie limitu Voucherify, skrypt ataku | `db.js`, `server.js` (`settle`, `returnPoints`), `atak.js`, `ZAGROZENIA.md` |

## Karty etapu IV

| Karta | Zakres | Gdzie w kodzie |
|---|---|---|
| A. Lista oczekujących | `soldOut`, zapis, miejsce w kolejce, wypisanie, przycisk „Powiadom mnie”, strona kolejki | `server.js` (`/api/events/:id/waitlist`, `/api/waitlist/:id`, `waitlistView`), `db.js`, `event.html`, `waitlist.html`, `events.js` (`waitlist-test`) |
| B. Miejsce dla pierwszej osoby | przydział zwolnionego fotela kolejce, blokada dla osób z zewnątrz, zwolnienie oferty przy wypisaniu | `server.js` (`offerFreeSeats`, `cancelOffer`, `settle`) |
| C. Powiadomienie | mail z ofertą, webhook Resenda `email.bounced` | `mail.js` (`sendOffer`, `verifyWebhook`), `server.js` (`sendOfferEmail`, `handleUndelivered`, `/api/webhooks/resend`) |
| Z listy zagrożeń | podpis webhooka Resenda, blokady przy przydziale, ponawianie maili, pamięć salda (III.A3), skrypt ataku | `mail.js`, `server.js`, `loyalty.js`, `atak.js`, `ZAGROZENIA.md` |
