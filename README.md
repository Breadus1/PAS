# KinoBilet

Kasa biletowa kina (PAS S01). Klient wybiera seans i fotel, rezerwuje go na 15 minut, a potem kupuje bilet i dostaje kod.

## Uruchomienie

```
npm install
npm start
```

Strona: http://localhost:3000

Czas rezerwacji ustawia zmienna `RESERVATION_MINUTES` (domyślnie 15). Tryb testowy:

```
RESERVATION_MINUTES=2 npm start
```

W PowerShellu: `$env:RESERVATION_MINUTES=2; npm start`

## API

| Metoda | Adres | Odpowiedź |
|---|---|---|
| GET | `/api/events` | lista seansów |
| GET | `/api/events/:id` | `{ event, takenSeats }` |
| POST | `/api/reservations` | `{ reservationId, expiresAt }` |
| GET | `/api/reservations/:id` | szczegóły rezerwacji |
| POST | `/api/reservations/:id/purchase` | `{ code }` |

Body rezerwacji: `{ eventId, seatId, customerName, email }`, np. `seatId: "F7"`.

## Strony

- `/` – repertuar
- `/events/:id` – mapa sali
- `/reserve?eventId=…&seatId=…` – formularz rezerwacji
- `/reservations/:id` – licznik czasu, zakup i bilet z kodem

## Sprawdzenie kryteriów

```
node atak.js http://localhost:3000
```
