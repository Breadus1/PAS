const express = require('express');
const path = require('path');
const crypto = require('crypto');
const events = require('./events');
const rateLimit = require('./rateLimit');
const db = require('./db');
const loyalty = require('./loyalty');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'brak-klucza');

const app = express();
const PORT = process.env.PORT || 3000;
const RESERVATION_MINUTES = Number(process.env.RESERVATION_MINUTES) || 15;
const reservationLimit = rateLimit(30, 10 * 1000);
const loyaltyLimit = rateLimit(20, 60 * 1000);

app.set('trust proxy', 3);

function findEvent(id) {
  return events.find((event) => event._id === id);
}

function statusOf(reservation) {
  if (reservation.status === 'paid') {
    return 'paid';
  }
  return reservation.expires_at > new Date() ? 'held' : 'expired';
}

async function takenSeats(eventId) {
  const { rows } = await db.query(
    "SELECT seat_id FROM reservations WHERE event_id = $1 AND (status = 'paid' OR expires_at > $2)",
    [eventId, new Date()]
  );
  return rows.map((row) => row.seat_id);
}

async function findReservation(id) {
  const { rows } = await db.query('SELECT * FROM reservations WHERE id = $1', [id]);
  return rows[0];
}

function lockSeat(client, eventId, seatId) {
  return db.lock(client, `fotel:${eventId}:${seatId}`);
}

function isFilled(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function reservationResponse(reservation) {
  return {
    reservationId: reservation.id,
    expiresAt: reservation.expires_at.toISOString(),
    amount: reservation.amount,
  };
}

function createCheckoutSession(reservation, baseUrl) {
  const event = findEvent(reservation.event_id);
  const returnUrl = `${baseUrl}/reservations/${reservation.id}`;

  return stripe.checkout.sessions.create({
    mode: 'payment',
    client_reference_id: reservation.id,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'pln',
          unit_amount: reservation.amount,
          product_data: {
            name: `${event.title}, ${event.hall}, fotel ${reservation.seat_id}`,
          },
        },
      },
    ],
    success_url: `${returnUrl}?payment=success`,
    cancel_url: `${returnUrl}?payment=cancelled`,
  });
}

async function handlePayment(reservationId, session) {
  const reservation = await findReservation(reservationId);
  if (!reservation) {
    return;
  }

  const paidInTime = await db.transaction(async (client) => {
    await lockSeat(client, reservation.event_id, reservation.seat_id);
    const { rows } = await client.query('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [reservationId]);
    const current = rows[0];

    if (current.status === 'paid') {
      return true;
    }
    if (current.expires_at > new Date()) {
      const code = crypto.randomBytes(4).toString('hex').toUpperCase();
      await client.query("UPDATE reservations SET status = 'paid', code = $2 WHERE id = $1", [reservationId, code]);
      return true;
    }
    return false;
  });

  if (!paidInTime) {
    await stripe.refunds.create(
      { payment_intent: session.payment_intent },
      { idempotencyKey: `refund-${session.id}` }
    );
  }
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

    if (session.client_reference_id && session.payment_status === 'paid') {
      await handlePayment(session.client_reference_id, session);
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

app.get('/api/events/:id', async (req, res) => {
  const event = findEvent(req.params.id);
  if (!event) {
    return res.status(404).json({ error: 'Nie ma takiego seansu' });
  }
  res.json({ event, takenSeats: await takenSeats(event._id) });
});

app.get('/api/loyalty', loyaltyLimit, async (req, res) => {
  const email = String(req.query.email || '').trim().replace(/ /g, '+');
  if (!email.includes('@')) {
    return res.status(400).json({ error: 'Podaj poprawny e-mail' });
  }

  try {
    const points = await loyalty.getBalance(db, email);
    res.json({ email: loyalty.normalize(email), points });
  } catch (err) {
    console.error('Loyalty:', err.message);
    res.status(503).json({ error: 'Program punktowy chwilowo nie działa, spróbuj za chwilę' });
  }
});

app.post('/api/reservations', reservationLimit, async (req, res) => {
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

  const result = await db.transaction(async (client) => {
    await lockSeat(client, eventId, seatId);

    const now = new Date();
    const { rows } = await client.query(
      "SELECT * FROM reservations WHERE event_id = $1 AND seat_id = $2 AND (status = 'paid' OR expires_at > $3)",
      [eventId, seatId, now]
    );
    const holder = rows[0];

    if (holder) {
      const sameRequest =
        holder.status === 'held' &&
        holder.customer_name === customerName &&
        holder.email === email;

      return sameRequest ? { status: 200, reservation: holder } : { status: 409 };
    }

    const expiresAt = new Date(now.getTime() + RESERVATION_MINUTES * 60 * 1000);
    const inserted = await client.query(
      `INSERT INTO reservations (id, event_id, seat_id, customer_name, email, amount, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [crypto.randomUUID(), eventId, seatId, customerName, email, event.price, expiresAt]
    );
    return { status: 201, reservation: inserted.rows[0] };
  });

  if (result.status === 409) {
    return res.status(409).json({ error: 'Ten fotel jest już zajęty' });
  }
  res.status(result.status).json(reservationResponse(result.reservation));
});

app.get('/api/reservations/:id', async (req, res) => {
  const reservation = await findReservation(req.params.id);
  if (!reservation) {
    return res.status(404).json({ error: 'Nie ma takiej rezerwacji' });
  }
  res.json({
    ...reservationResponse(reservation),
    eventId: reservation.event_id,
    seatId: reservation.seat_id,
    status: statusOf(reservation),
    code: reservation.code || undefined,
  });
});

app.post('/api/reservations/:id/checkout', async (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;

  let result;
  try {
    result = await db.transaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [req.params.id]);
      const reservation = rows[0];

      if (!reservation) {
        return { status: 404, error: 'Nie ma takiej rezerwacji' };
      }
      if (reservation.status === 'paid') {
        return { status: 409, error: 'Rezerwacja jest już opłacona' };
      }
      if (reservation.expires_at <= new Date()) {
        return { status: 410, error: 'Rezerwacja wygasła, fotel wrócił do puli' };
      }

      if (!reservation.checkout_url) {
        const session = await createCheckoutSession(reservation, baseUrl);
        reservation.checkout_url = session.url;
        await client.query('UPDATE reservations SET checkout_url = $2 WHERE id = $1', [reservation.id, session.url]);
      }
      return { status: 200, url: reservation.checkout_url };
    });
  } catch (err) {
    console.error('Checkout:', err.message);
    return res.status(503).json({ error: 'Płatności chwilowo nie działają, spróbuj za chwilę' });
  }

  if (result.error) {
    return res.status(result.status).json({ error: result.error });
  }
  res.json({ url: result.url });
});

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) {
    console.error(err);
  }
  res.status(status).json({ error: status < 500 ? 'Niepoprawne zapytanie' : 'Błąd serwera' });
});

if (!process.env.DATABASE_URL) {
  console.error('Brak zmiennej DATABASE_URL z adresem bazy Postgres');
  process.exit(1);
}

db.init().then(() => {
  app.listen(PORT, () => {
    console.log(`Serwer działa na http://localhost:${PORT}`);
  });
});
