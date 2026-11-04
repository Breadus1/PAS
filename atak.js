const stripe = require('stripe')('brak-klucza');

const BASE = process.argv[2] || 'http://localhost:3000';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

let failures = 0;

function check(name, ok, details) {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}${details !== undefined ? `  (${details})` : ''}`);
  if (!ok) failures++;
}

function skip(name, reason) {
  console.log(`--    ${name}  (pominięte: ${reason})`);
}

async function request(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, data, retryAfter: res.headers.get('retry-after') };
}

async function sendWebhook(reservationId, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify({
    id: `evt_atak_${reservationId}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_atak_${reservationId}`,
        client_reference_id: reservationId,
        payment_status: 'paid',
        payment_intent: 'pi_atak',
      },
    },
  });
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret });
  const res = await fetch(`${BASE}/api/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature },
    body: payload,
  });
  return res.status;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const is4xx = (r) => r.status >= 400 && r.status < 500;
const person = (n) => ({ customerName: `Tester ${n}`, email: `tester${n}@example.com` });
const expiry = (r) => new Date(r.data.expiresAt).getTime();

async function main() {
  console.log(`Atakuję ${BASE}`);
  if (!WEBHOOK_SECRET) {
    console.log('Bez STRIPE_WEBHOOK_SECRET testy webhooka zostaną pominięte.');
  }
  console.log();

  const events = (await request('GET', '/api/events')).data;
  const event = events[0];
  const taken = async () => (await request('GET', `/api/events/${event._id}`)).data.takenSeats;
  const startTaken = await taken();
  const free = event.seats.filter((seat) => !startTaken.includes(seat));

  const reserve = (seatId, n, headers) =>
    request('POST', '/api/reservations', { eventId: event._id, seatId, ...person(n) }, headers);
  const checkout = (id) => request('POST', `/api/reservations/${id}/checkout`);
  const status = async (id) => (await request('GET', `/api/reservations/${id}`)).data;

  const a1 = await request('GET', '/api/events/nie-ma-takiego');
  check('A1  nieistniejące wydarzenie', is4xx(a1), a1.status);

  const c3a = await checkout('abc');
  const c3b = await checkout('00000000-0000-0000-0000-000000000000');
  check('C3  płatność za błędne id', is4xx(c3a) && is4xx(c3b), `${c3a.status}, ${c3b.status}`);

  const c3c = await sendWebhook('abc', 'whsec_falszywy');
  check('C3  webhook ze złym podpisem', c3c === 400, c3c);

  const seatB3 = free.shift();
  const b3 = [
    await request('POST', '/api/reservations', { eventId: 'nie-ma', seatId: seatB3, ...person(1) }),
    await request('POST', '/api/reservations', { eventId: event._id, seatId: 'Z99', ...person(1) }),
    await request('POST', '/api/reservations', { eventId: event._id, seatId: seatB3, customerName: '', email: 'a@b.pl' }),
    await request('POST', '/api/reservations', { eventId: event._id, seatId: seatB3, customerName: 'Jan', email: '' }),
  ];
  const b3Saved = (await taken()).includes(seatB3);
  check('B3  błędne rezerwacje', b3.every(is4xx) && !b3Saved, b3.map((r) => r.status).join(', '));

  const seatSeq = free.shift();
  const b1a = await reserve(seatSeq, 2);
  const b1b = await reserve(seatSeq, 2);
  check('B1  podwójna rezerwacja po kolei', b1a.ok && b1b.ok && b1a.data.reservationId === b1b.data.reservationId, `${b1a.status}, ${b1b.status}`);
  check('II  amount w rezerwacji = price seansu', b1a.data.amount === event.price, `${b1a.data.amount} / ${event.price}`);

  const seatPar = free.shift();
  const [b1c, b1d] = await Promise.all([reserve(seatPar, 3), reserve(seatPar, 3)]);
  check('B1  podwójna rezerwacja równolegle', b1c.ok && b1d.ok && b1c.data.reservationId === b1d.data.reservationId, `${b1c.status}, ${b1d.status}`);

  const c1a = await checkout(b1a.data.reservationId);
  if (c1a.status === 503) {
    skip('C1  podwójna płatność', 'serwer nie ma kluczy Stripe');
  } else {
    const c1b = await checkout(b1a.data.reservationId);
    check('C1  podwójna płatność po kolei: ta sama sesja', c1a.ok && c1b.ok && c1a.data.url === c1b.data.url, `${c1a.status}, ${c1b.status}`);
    const [c1c, c1d] = await Promise.all([checkout(b1c.data.reservationId), checkout(b1c.data.reservationId)]);
    check('C1  podwójna płatność równolegle: ta sama sesja', c1c.ok && c1d.ok && c1c.data.url === c1d.data.url, `${c1c.status}, ${c1d.status}`);
  }

  if (WEBHOOK_SECRET) {
    const id = b1a.data.reservationId;
    const first = await sendWebhook(id);
    const codeBefore = (await status(id)).code;
    const again = [await sendWebhook(id), ...(await Promise.all([sendWebhook(id), sendWebhook(id)]))];
    const after = await status(id);
    check('C1  webhook 4× dla jednej płatności: jeden bilet', after.status === 'paid' && after.code && after.code === codeBefore, `${first}, ${again.join(', ')}; kod ${after.code}`);

    const paidAgain = await checkout(id);
    check('C4  płatność za opłaconą rezerwację', is4xx(paidAgain), paidAgain.status);
  } else {
    skip('C1  webhook dla jednej płatności', 'brak STRIPE_WEBHOOK_SECRET');
  }

  console.log('\nCzekam 11 s na reset limitu…');
  await sleep(11000);

  const seatRace = free.shift();
  const race = await Promise.all(Array.from({ length: 20 }, (_, i) => reserve(seatRace, 100 + i)));
  const wins = race.filter((r) => r.ok).length;
  const rejected = race.filter(is4xx).length;
  check('B2  20 równoczesnych rezerwacji', wins === 1 && rejected === 19, `${wins}× 2xx, ${rejected}× 4xx`);

  console.log('\nCzekam 11 s na reset limitu…');
  await sleep(11000);

  const seatExpire = free.shift();
  const seatAfter = free.shift();
  const seatLate = free.shift();
  const seatPaid = free.shift();
  const raceSeats = free.splice(0, 5);

  const rExpire = await reserve(seatExpire, 200);
  const rAfter = await reserve(seatAfter, 201);
  const rLate = await reserve(seatLate, 202);
  const rPaid = await reserve(seatPaid, 203);
  const rRace = await Promise.all(raceSeats.map((seat, i) => reserve(seat, 210 + i)));

  if (WEBHOOK_SECRET) {
    await sendWebhook(rPaid.data.reservationId);
  }

  const waitSeconds = Math.round((expiry(rRace[4]) - Date.now()) / 1000);
  console.log(`\nCzekam ${waitSeconds} s na wygaśnięcie rezerwacji…`);

  if (WEBHOOK_SECRET) {
    const c2 = await Promise.all(rRace.map(async (r, i) => {
      await sleep(expiry(r) - Date.now());
      const [, steal] = await Promise.all([
        sendWebhook(r.data.reservationId),
        reserve(raceSeats[i], 300 + i),
      ]);
      const xPaid = (await status(r.data.reservationId)).status === 'paid';
      return xPaid !== steal.ok;
    }));
    check('C2  zapłata X i rezerwacja Y w chwili wygaśnięcia (5×)', c2.every(Boolean), c2.map((ok) => (ok ? 'ok' : 'DWÓCH/ŻADEN')).join(', '));
  } else {
    await sleep(expiry(rRace[4]) - Date.now());
    skip('C2  zapłata w chwili wygaśnięcia', 'brak STRIPE_WEBHOOK_SECRET');
  }

  await sleep(1000);
  const takenNow = await taken();
  check('A2  wygasła rezerwacja znika z takenSeats', !takenNow.includes(seatExpire));
  check('II  status wygasłej rezerwacji = expired', (await status(rExpire.data.reservationId)).status === 'expired');

  const b4 = await reserve(seatAfter, 400);
  check('B4  po wygaśnięciu ktoś inny rezerwuje', b4.ok, b4.status);

  const c4 = await checkout(rLate.data.reservationId);
  check('C4  płatność po czasie', is4xx(c4), c4.status);

  if (WEBHOOK_SECRET) {
    const paid = await status(rPaid.data.reservationId);
    check('C4  opłacone miejsce dalej zajęte', takenNow.includes(seatPaid) && paid.status === 'paid', paid.status);
  } else {
    skip('C4  opłacone miejsce dalej zajęte', 'brak STRIPE_WEBHOOK_SECRET');
  }

  console.log('\nCzekam 11 s na reset limitu…');
  await sleep(11000);

  const spamSeats = events.slice(1).flatMap((e) => e.seats.map((seatId) => ({ eventId: e._id, seatId }))).slice(0, 100);
  const spam = spamSeats.map((seat, i) =>
    request('POST', '/api/reservations', { ...seat, ...person(500 + i) }, { 'X-Forwarded-For': '10.0.0.1' })
  );
  const other = request('POST', '/api/reservations', { eventId: event._id, seatId: free.shift(), ...person(999) }, { 'X-Forwarded-For': '10.0.0.2' });

  const spamResults = await Promise.all(spam);
  const otherResult = await other;
  const limited = spamResults.filter((r) => r.status === 429);
  check('B5  limit: 429 z Retry-After', limited.length > 0 && limited.every((r) => r.retryAfter), `${limited.length}× 429`);
  check('B5  drugi klient rezerwuje bez problemu', otherResult.ok, `${otherResult.status}; na serwerze w sieci sprawdź z telefonu`);

  console.log(failures === 0 ? '\nWszystko OK' : `\nProblemy: ${failures}`);
}

main().catch((err) => {
  console.error('Atak przerwany:', err.message);
  process.exit(1);
});
