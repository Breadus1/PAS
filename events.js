const ROWS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const SEATS_IN_ROW = 10;

const seats = [];
for (const row of ROWS) {
  for (let number = 1; number <= SEATS_IN_ROW; number++) {
    seats.push(row + number);
  }
}

const events = [
  {
    _id: 'seans-2026-11-21-1800',
    title: 'Kosmiczna podróż',
    startsAt: '2026-11-21T18:00:00+01:00',
    hall: 'Sala 1',
    price: 3200,
    seats,
  },
  {
    _id: 'seans-2026-11-21-2030',
    title: 'Cicha zatoka',
    startsAt: '2026-11-21T20:30:00+01:00',
    hall: 'Sala 2',
    price: 3200,
    seats,
  },
  {
    _id: 'seans-2026-11-22-1700',
    title: 'Ostatni seans',
    startsAt: '2026-11-22T17:00:00+01:00',
    hall: 'Sala 1',
    price: 3200,
    seats,
  },
];

module.exports = events;
