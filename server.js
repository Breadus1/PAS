const express = require('express');
const path = require('path');
const events = require('./events');

const app = express();
const PORT = process.env.PORT || 3000;

const reservations = [];

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function findEvent(id) {
  return events.find((event) => event._id === id);
}

function holdsSeat(reservation, now) {
  return reservation.status === 'purchased' || reservation.expiresAt > now;
}

function takenSeats(eventId) {
  const now = Date.now();
  return reservations
    .filter((r) => r.eventId === eventId && holdsSeat(r, now))
    .map((r) => r.seatId);
}

function page(file) {
  return (req, res) => res.sendFile(path.join(__dirname, 'public', file));
}

app.get('/events/:id', page('event.html'));

app.get('/api/events', (req, res) => {
  res.json(events);
});

app.get('/api/events/:id', (req, res) => {
  const event = findEvent(req.params.id);
  if (!event) {
    return res.status(404).json({ error: 'Nie ma takiego seansu' });
  }
  res.json({ event, takenSeats: takenSeats(event._id) });
});

app.listen(PORT, () => {
  console.log(`Serwer działa na http://localhost:${PORT}`);
});
