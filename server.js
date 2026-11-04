const express = require('express');
const path = require('path');
const crypto = require('crypto');
const events = require('./events');
const rateLimit = require('./rateLimit');

const app = express();
const PORT = process.env.PORT || 3000;
const RESERVATION_MINUTES = Number(process.env.RESERVATION_MINUTES) || 15;

const reservations = [];

app.set('trust proxy', 2);
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

function findReservation(id) {
  return reservations.find((reservation) => reservation._id === id);
}

function isFilled(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function reservationResponse(reservation) {
  return {
    reservationId: reservation._id,
    expiresAt: new Date(reservation.expiresAt).toISOString(),
  };
}

function page(file) {
  return (req, res) => res.sendFile(path.join(__dirname, 'public', file));
}

app.get('/events/:id', page('event.html'));
app.get('/reserve', page('reserve.html'));
app.get('/reservations/:id', page('reservation.html'));

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

app.post('/api/reservations', rateLimit, (req, res) => {
  const { eventId, seatId, customerName, email } = req.body || {};

  const event = findEvent(eventId);
  if (!event) {
    return res.status(404).json({ error: 'Nie ma takiego seansu' });
  }
  if (!event.seats.includes(seatId)) {
    return res.status(400).json({ error: 'Nie ma takiego fotela' });
  }
  if (!isFilled(customerName) || !isFilled(email) || !email.includes('@')) {
    return res.status(400).json({ error: 'Podaj imię i poprawny e-mail' });
  }

  const now = Date.now();
  const holder = reservations.find(
    (r) => r.eventId === eventId && r.seatId === seatId && holdsSeat(r, now)
  );

  if (holder) {
    const sameRequest =
      holder.status === 'reserved' &&
      holder.customerName === customerName &&
      holder.email === email;

    if (sameRequest) {
      return res.status(200).json(reservationResponse(holder));
    }
    return res.status(409).json({ error: 'Ten fotel jest już zajęty' });
  }

  const reservation = {
    _id: crypto.randomUUID(),
    eventId,
    seatId,
    customerName,
    email,
    expiresAt: now + RESERVATION_MINUTES * 60 * 1000,
    status: 'reserved',
    code: null,
  };
  reservations.push(reservation);

  res.status(201).json(reservationResponse(reservation));
});

app.get('/api/reservations/:id', (req, res) => {
  const reservation = findReservation(req.params.id);
  if (!reservation) {
    return res.status(404).json({ error: 'Nie ma takiej rezerwacji' });
  }
  res.json({
    ...reservationResponse(reservation),
    eventId: reservation.eventId,
    seatId: reservation.seatId,
    status: reservation.status,
    code: reservation.code,
  });
});

app.post('/api/reservations/:id/purchase', (req, res) => {
  const reservation = findReservation(req.params.id);
  if (!reservation) {
    return res.status(404).json({ error: 'Nie ma takiej rezerwacji' });
  }
  if (reservation.status === 'purchased') {
    return res.json({ code: reservation.code });
  }
  if (reservation.expiresAt <= Date.now()) {
    return res.status(410).json({ error: 'Rezerwacja wygasła, fotel wrócił do puli' });
  }

  reservation.status = 'purchased';
  reservation.code = crypto.randomBytes(4).toString('hex').toUpperCase();
  res.json({ code: reservation.code });
});

app.get('/api/debug-ip', (req, res) => {
  res.json({
    ip: req.ip,
    ips: req.ips,
    remote: req.socket.remoteAddress,
    forwardedFor: req.headers['x-forwarded-for'] || null,
    cfConnectingIp: req.headers['cf-connecting-ip'] || null,
    trueClientIp: req.headers['true-client-ip'] || null,
  });
});

app.use((err, req, res, next) => {
  const status = err.status || 500;
  res.status(status).json({ error: status < 500 ? 'Niepoprawne zapytanie' : 'Błąd serwera' });
});

app.listen(PORT, () => {
  console.log(`Serwer działa na http://localhost:${PORT}`);
});
