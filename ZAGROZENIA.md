# Lista zagrożeń

## Rezerwacje (etap I)

| Zagrożenie | Co robimy |
|---|---|
| Dwie osoby rezerwują ten sam fotel w tej samej chwili | Rezerwacja to transakcja w bazie z blokadą na ten fotel (`pg_advisory_xact_lock`). Sprawdzenie, czy fotel wolny, i zapis dzieją się pod blokadą, więc wygrywa jedna osoba, reszta dostaje 409. Działa także przy kilku instancjach serwera |
| Podwójne kliknięcie „Zarezerwuj” | Ten sam klient z tymi samymi danymi dostaje tę samą rezerwację, przycisk blokuje się po kliknięciu |
| Rezerwacja nie zwalnia się po czasie | Ważność liczona przy każdym odczycie z `expires_at`, fotel wraca do puli od razu |
| Błędne dane (zły seans, fotel, puste pola, id `abc`) | Walidacja przed zapisem, odpowiedź 4xx, nic nie jest zapisywane; id rezerwacji to tekst, więc dziwne id daje 404, a nie błąd bazy |
| Zalew rezerwacji z jednego adresu | Limit 30 rezerwacji na 10 s na adres IP, potem 429 z `Retry-After`; adres ustalany za Cloudflare i proxy Rendera, fałszywy `X-Forwarded-For` jest ignorowany |
| Restart serwera (nowe wdrożenie, uśpienie darmowego Rendera) | Rezerwacje, płatności i punkty są w bazie Postgres, nie w pamięci procesu, więc restart niczego nie kasuje |

## Płatności Stripe (etap II)

| Zagrożenie | Co robimy |
|---|---|
| Stripe nie odpowiada | `/checkout` zwraca 503 z komunikatem, rezerwacja zostaje i można spróbować ponownie |
| Ktoś podszywa się pod Stripe i wysyła fałszywy webhook | Podpis sprawdzany przez `stripe.webhooks.constructEvent`, bez poprawnego podpisu 400 |
| Podpisane zdarzenie bez naszej rezerwacji (`stripe trigger`) | Odpowiedź 200, nic się nie zmienia |
| Stripe wysyła ten sam webhook kilka razy | Rezerwacja jest blokowana w bazie (`SELECT … FOR UPDATE`); opłacona nie zmienia się drugi raz, kod biletu, punkty i mail tylko raz |
| Podwójne kliknięcie „Zapłać” | Checkout blokuje wiersz rezerwacji w bazie; pierwsze żądanie tworzy sesję i zapisuje jej adres, kolejne czekają i dostają ten sam adres |
| Płatność dociera po wygaśnięciu rezerwacji, a fotel mógł już zająć ktoś inny | Webhook i rezerwacja biorą tę samą blokadę fotela; spóźniona płatność nie daje biletu, tylko automatyczny zwrot pieniędzy (klucz idempotencji, więc zwrot nie wykona się dwa razy) i punktów |
| Klient przerywa płatność | Wraca na stronę rezerwacji i może zapłacić ponownie, dopóki rezerwacja jest ważna |
| Klient zmienia kwotę | Kwota zapisana w rezerwacji, sesję płatności tworzy serwer; `{ amount }` z przeglądarki jest ignorowane |
| Ktoś wchodzi na `?payment=success` bez płacenia | Status zmienia tylko webhook; strona pisze „czekamy na potwierdzenie”, a nie że zapłacono |
| Klient zamyka kartę przed powrotem ze Stripe'a | Bilet daje webhook, nie strona powrotu; otwarta strona sama sprawdza status co 2 s |
| Wyciek kluczy | Klucze tylko w zmiennych środowiskowych na Renderze; przeglądarka dostaje tylko adres strony płatności |

## Punkty Voucherify i maile Resend (etap III)

| Zagrożenie | Co robimy |
|---|---|
| Limit sandboxa Voucherify: 100 wywołań na godzinę | Voucherify wołamy tylko przy saldzie, płatności punktami i dopisywaniu punktów; rezerwacje i checkout bez punktów go nie dotykają. Numer karty klienta zapamiętujemy w bazie, punkty powitalne i za zakup dopisujemy jednym wywołaniem. `GET /api/loyalty` ma limit 20 zapytań na minutę na adres IP |
| Voucherify nie odpowiada albo zwraca 429 | Saldo i płatność punktami: 503 z komunikatem. Płatność bez punktów działa dalej. Punkty za zakup dopisze później sprzątacz (ponawia co minutę), bilet powstaje od razu |
| Klient chce zapłacić punktami więcej niż połowę ceny albo więcej, niż ma | 400 przed utworzeniem sesji; saldo sprawdzamy w Voucherify, bo to on jest źródłem prawdy |
| Dwa „Zapłać” z punktami naraz (ta sama albo dwie rezerwacje jednego klienta) | Blokada wiersza rezerwacji i blokada klienta w bazie; punkty schodzą raz, druga rezerwacja widzi już mniejsze saldo |
| Klient wydał punkty, ale nie zapłacił w czasie | Sprzątacz co 5 s oddaje punkty z wygasłych rezerwacji; flaga `points_returned` pilnuje, żeby oddać tylko raz (także gdy płatność przyjdzie po czasie) |
| Punkty zeszły, a Stripe nie utworzył sesji | Punkty wracają od razu, klient dostaje 503 i może spróbować ponownie |
| Powtórzony webhook dopisuje punkty drugi raz | Flaga `points_awarded` ustawiana atomowo w bazie przed wywołaniem Voucherify |
| Resend nie działa albo odrzuca adres | Bilet i tak jest ważny i widoczny na stronie. Mail ponawiamy do 5 razy; klucz idempotencji `bilet-<id>` w Resend, więc klient nie dostanie dwóch maili |
| Mail tylko na adresy testowe | Bez własnej domeny Resend wysyła z `onboarding@resend.dev` tylko na adres właściciela konta i `delivered@resend.dev` / `bounced@resend.dev` (także z `+etykieta`) |
| Wstrzyknięcie HTML w imieniu klienta do maila | Imię jest escapowane przed wstawieniem do treści maila |
| Adres z `+` wpisany w adresie bez kodowania | `GET /api/loyalty` zamienia spację z powrotem na `+` (e-mail nie może zawierać spacji) |

## Lista oczekujących i webhook Resenda (etap IV)

| Zagrożenie | Co robimy |
|---|---|
| Zwolnione miejsce zajmuje ktoś z zewnątrz, zanim dostanie je kolejka | Gdy ktoś czeka w kolejce, `POST /api/reservations` na ten seans zwraca 409; sprzątacz co 5 s oddaje wolne fotele kolejce |
| Dwie instancje albo dwa przebiegi sprzątacza dają to samo miejsce dwóm osobom | Przydział miejsc działa pod blokadą listy danego seansu i blokadą fotela; przed założeniem rezerwacji sprawdzamy jeszcze raz, czy fotel jest wolny |
| Ktoś podszywa się pod Resend i „odbija” cudzy mail, żeby przejąć miejsce | Webhook Resenda ma podpis Svix (HMAC-SHA256 sekretem `RESEND_WEBHOOK_SECRET`, najwyżej 5 minut różnicy czasu); bez poprawnego podpisu 400 |
| Resend wysyła to samo `email.bounced` kilka razy | Wpis zmienia się z `offered` na `missed` tylko raz, kolejne powtórki nic nie robią |
| Mail z ofertą nie dochodzi (nieistniejący adres) | `email.bounced` / `email.failed` od razu zwalnia rezerwację i daje miejsce następnej osobie, nie czekamy do końca czasu |
| Resend nie działa przy wysyłce oferty | Sprzątacz ponawia mail, dopóki oferta jest ważna; gdy się nie uda, oferta wygasa i miejsce idzie dalej. Klient widzi ofertę także na stronie `/waitlist/:id` |
| Limity Resend (2 zapytania na sekundę, 100 maili dziennie na darmowym planie) | Maile nieudane z powodu limitu ponawiamy; klucz idempotencji `oferta-<id>` / `bilet-<id>`, więc nikt nie dostanie maila dwa razy |
| Ktoś zapisuje się wiele razy albo zasypuje listę | Ponowny zapis tym samym e-mailem zwraca ten sam wpis; limit 30 zapisów na 10 s na adres IP |
| Osoba z ofertą wypisuje się albo nie płaci | Wypisanie zwalnia jej rezerwację od razu; niezapłacona rezerwacja wygasa jak zwykła; wydane punkty wracają przez sprzątacza |
| Spóźniona płatność za ofertę, która przeszła już do kolejnej osoby | Jak w etapie II: webhook pod blokadą fotela widzi wygasłą rezerwację, zwrot pieniędzy i punktów |
| Vercel Cron na darmowym planie działa raz dziennie | Nie używamy Vercela: serwer na Renderze działa stale, sprzątacz co 5 s |

## Znane ryzyka

| Ryzyko | Skutek |
|---|---|
| Usypianie darmowego serwera | Pierwsze zapytanie po przerwie trwa około minuty; dane zostają w bazie, a sprzątacz po przebudzeniu kończy zaległe zwroty punktów i maile |
| Baza Postgres to kolejna usługa zewnętrzna | Gdy baza nie odpowiada, API zwraca 5xx; darmowa baza Neon usypia się po bezczynności i budzi przy pierwszym zapytaniu |
| Webhook nie dociera (np. zły adres w panelu Stripe) | Strona czeka na status, po czasie pokazuje wygaśnięcie; Stripe ponawia webhooki i spóźniona płatność kończy się zwrotem |
| Nie da się założyć konta Voucherify (25.11.2026: błąd „Something went wrong” przy rejestracji w każdej przeglądarce i sieci, zrzut w `docs/voucherify-rejestracja-blad.png`) | Bez kluczy saldo i płatność punktami dają 503, zakupy bez punktów, bilety i maile działają; po założeniu konta wystarczy ustawić zmienne `VOUCHERIFY_*` |
| `waitlist-test` ma tylko dwa miejsca | Kupione bilety nigdy się nie zwalniają, więc po opłaceniu obu miejsc seans zostaje wyprzedany na stałe i kolejka nie ruszy; `atak.js` niczego tam nie kupuje |
| Wyczerpany limit Voucherify w trakcie testu | Do końca godziny saldo i płatność punktami dają 503; zakupy bez punktów działają, punkty za zakup dopisują się po odnowieniu limitu |
