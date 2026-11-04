const express = require('express');
const path = require('path');
const crypto = require('crypto');
const events = require('./events');
const rateLimit = require('./rateLimit');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'brak-klucza');

const app = express();
const PORT = process.env.PORT || 3000;
const RESERVATION_MINUTES = Number(process.env.RESERVATION_MINUTES) || 15;

const reservations = [];

app.set('trust proxy', 3);

function findEvent(id) {
  return events.find((event) => event._id === id);
}

function holdsSeat(reservation, now) {
  return reservation.status === 'paid' || reservation.expiresAt > now;
}

function statusOf(reservation) {
  if (reservation.status === 'paid') {
    return 'paid';
  }
  return reservation.expiresAt > Date.now() ? 'held' : 'expired';
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
    amount: reservation.amount,
  };
}

function createCheckoutSession(reservation, baseUrl) {
  const event = findEvent(reservation.eventId);
  const returnUrl = `${baseUrl}/reservations/${reservation._id}`;

  return stripe.checkout.sessions.create({
    mode: 'payment',
    client_reference_id: reservation._id,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'pln',
          unit_amount: reservation.amount,
          product_data: {
            name: `${event.title}, ${event.hall}, fotel ${reservation.seatId}`,
          },
        },
      },
    ],
    success_url: `${returnUrl}?payment=success`,
    cancel_url: `${returnUrl}?payment=cancelled`,
  });
}

async function handlePayment(reservation, session) {
  if (reservation.status === 'paid') {
    return;
  }

  if (reservation.expiresAt > Date.now()) {
    reservation.status = 'paid';
    reservation.code = crypto.randomBytes(4).toString('hex').toUpperCase();
    return;
  }

  await stripe.refunds.create(
    { payment_intent: session.payment_intent },
    { idempotencyKey: `refund-${session.id}` }
  );
}

function page(file) {
  return (req, res) => res.sendFile(path.join(__dirname, 'public', file));
}

app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).json({ error: 'Niepoprawny podpis webhooka' });
  }

  const paymentEvents = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];

  if (paymentEvents.includes(event.type)) {
    const session = event.data.object;
    console.log(`Webhook: ${session.payment_status}, rezerwacja ${session.client_reference_id}`);

    const reservation = findReservation(session.client_reference_id);
    if (reservation && session.payment_status === 'paid') {
      await handlePayment(reservation, session);
    }
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
      holder.status === 'held' &&
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
    amount: event.price,
    expiresAt: now + RESERVATION_MINUTES * 60 * 1000,
    status: 'held',
    code: null,
    checkout: null,
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
    status: statusOf(reservation),
    code: reservation.code || undefined,
  });
});

app.post('/api/reservations/:id/checkout', async (req, res) => {
  const reservation = findReservation(req.params.id);
  if (!reservation) {
    return res.status(404).json({ error: 'Nie ma takiej rezerwacji' });
  }
  if (reservation.status === 'paid') {
    return res.status(409).json({ error: 'Rezerwacja jest już opłacona' });
  }
  if (reservation.expiresAt <= Date.now()) {
    return res.status(410).json({ error: 'Rezerwacja wygasła, fotel wrócił do puli' });
  }

  if (!reservation.checkout) {
    reservation.checkout = createCheckoutSession(reservation, `${req.protocol}://${req.get('host')}`);
  }

  try {
    const session = await reservation.checkout;
    res.json({ url: session.url });
  } catch (err) {
    reservation.checkout = null;
    console.error('Stripe:', err.message);
    res.status(503).json({ error: 'Płatności chwilowo nie działają, spróbuj za chwilę' });
  }
});

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) {
    console.error(err);
  }
  res.status(status).json({ error: status < 500 ? 'Niepoprawne zapytanie' : 'Błąd serwera' });
});

app.listen(PORT, () => {
  console.log(`Serwer działa na http://localhost:${PORT}`);
});
