# Lista zagrożeń

## Rezerwacje (etap I)

| Zagrożenie | Co robimy |
|---|---|
| Dwie osoby rezerwują ten sam fotel w tej samej chwili | Sprawdzenie, czy fotel wolny, i zapis rezerwacji dzieją się bez przerwy (bez `await`), więc wygrywa jedna osoba, reszta dostaje 409 |
| Podwójne kliknięcie „Zarezerwuj” | Ten sam klient z tymi samymi danymi dostaje tę samą rezerwację, przycisk blokuje się po kliknięciu |
| Rezerwacja nie zwalnia się po czasie | Ważność liczona przy każdym odczycie z `expiresAt`, fotel wraca do puli od razu |
| Błędne dane (zły seans, fotel, puste pola) | Walidacja przed zapisem, odpowiedź 4xx, nic nie jest zapisywane |
| Zalew rezerwacji z jednego adresu | Limit 30 rezerwacji na 10 s na adres IP, potem 429 z `Retry-After`; adres ustalany za Cloudflare i proxy Rendera, fałszywy `X-Forwarded-For` jest ignorowany |

## Płatności Stripe (etap II)

| Zagrożenie | Co robimy |
|---|---|
| Stripe nie odpowiada | `/checkout` zwraca 503 z komunikatem, rezerwacja zostaje i można spróbować ponownie |
| Ktoś podszywa się pod Stripe i wysyła fałszywy webhook | Podpis sprawdzany przez `stripe.webhooks.constructEvent`, bez poprawnego podpisu 400 |
| Stripe wysyła ten sam webhook kilka razy | Opłacona rezerwacja nie zmienia się drugi raz, kod biletu zostaje ten sam |
| Podwójne kliknięcie „Zapłać” | Jedna sesja Checkout na rezerwację, równoległe żądania dostają ten sam adres płatności |
| Płatność dociera po wygaśnięciu rezerwacji, a fotel mógł już zająć ktoś inny | Bez biletu i automatyczny zwrot pieniędzy (z kluczem idempotencji, więc zwrot nie wykona się dwa razy); fotel zawsze ma jednego właściciela |
| Klient przerywa płatność | Wraca na stronę rezerwacji i może zapłacić ponownie, dopóki rezerwacja jest ważna |
| Klient zmienia kwotę | Kwota zapisana w rezerwacji, sesję płatności tworzy serwer; przeglądarka nie wysyła kwoty |
| Wyciek kluczy | Klucze tylko w zmiennych środowiskowych na Renderze; przeglądarka dostaje tylko adres strony płatności |
| Webhook nie dociera (np. zły adres w panelu Stripe) | Strona „płatność w toku…” czeka na status; webhooki są logowane w Renderze |

## Znane ryzyka

| Ryzyko | Skutek |
|---|---|
| Dane trzymane w pamięci serwera | Restart (nowe wdrożenie, uśpienie darmowego Rendera po 15 min bez ruchu) kasuje rezerwacje i bilety; webhook do nieznanej rezerwacji jest pomijany, zwrot trzeba zrobić ręcznie w panelu Stripe |
| Usypianie darmowego serwera | Pierwsze zapytanie po przerwie trwa około minuty |
