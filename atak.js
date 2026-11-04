const BASE = process.argv[2] || 'http://localhost:3000';

let failures = 0;

function check(name, ok, details) {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}${details !== undefined ? `  (${details})` : ''}`);
  if (!ok) failures++;
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const is4xx = (r) => r.status >= 400 && r.status < 500;
const person = (n) => ({ customerName: `Tester ${n}`, email: `tester${n}@example.com` });
const expiry = (r) => new Date(r.data.expiresAt).getTime();

async function main() {
  console.log(`Atakuję ${BASE}\n`);

  const events = (await request('GET', '/api/events')).data;
  const event = events[0];
  const taken = async () => (await request('GET', `/api/events/${event._id}`)).data.takenSeats;
  const startTaken = await taken();
  const free = event.seats.filter((seat) => !startTaken.includes(seat));

  const reserve = (seatId, n, headers) =>
    request('POST', '/api/reservations', { eventId: event._id, seatId, ...person(n) }, headers);
  const purchase = (id) => request('POST', `/api/reservations/${id}/purchase`);

  const a1 = await request('GET', '/api/events/nie-ma-takiego');
  check('A1  nieistniejące wydarzenie', is4xx(a1), a1.status);

  const c3a = await purchase('abc');
  const c3b = await purchase('00000000-0000-0000-0000-000000000000');
  check('C3  zakup z błędnym id', is4xx(c3a) && is4xx(c3b), `${c3a.status}, ${c3b.status}`);

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

  const seatPar = free.shift();
  const [b1c, b1d] = await Promise.all([reserve(seatPar, 3), reserve(seatPar, 3)]);
  check('B1  podwójna rezerwacja równolegle', b1c.ok && b1d.ok && b1c.data.reservationId === b1d.data.reservationId, `${b1c.status}, ${b1d.status}`);

  const c1a = await purchase(b1a.data.reservationId);
  const c1b = await purchase(b1a.data.reservationId);
  check('C1  podwójny zakup po kolei', c1a.ok && c1b.ok && c1a.data.code === c1b.data.code, `${c1a.status}, ${c1b.status}`);

  const [c1c, c1d] = await Promise.all([purchase(b1c.data.reservationId), purchase(b1c.data.reservationId)]);
  check('C1  podwójny zakup równolegle', c1c.ok && c1d.ok && c1c.data.code === c1d.data.code, `${c1c.status}, ${c1d.status}`);

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
  const seatBought = free.shift();
  const raceSeats = free.splice(0, 5);

  const rExpire = await reserve(seatExpire, 200);
  const rAfter = await reserve(seatAfter, 201);
  const rLate = await reserve(seatLate, 202);
  const rBought = await reserve(seatBought, 203);
  const rRace = await Promise.all(raceSeats.map((seat, i) => reserve(seat, 210 + i)));
  await purchase(rBought.data.reservationId);

  const waitSeconds = Math.round((expiry(rRace[4]) - Date.now()) / 1000);
  console.log(`\nCzekam ${waitSeconds} s na wygaśnięcie rezerwacji…`);

  const c2 = await Promise.all(rRace.map(async (r, i) => {
    await sleep(expiry(r) - Date.now());
    const [buy, steal] = await Promise.all([
      purchase(r.data.reservationId),
      reserve(raceSeats[i], 300 + i),
    ]);
    return buy.ok !== steal.ok;
  }));
  check('C2  zakup i cudza rezerwacja w chwili wygaśnięcia (5×)', c2.every(Boolean), c2.map((ok) => (ok ? 'ok' : 'DWÓCH')).join(', '));

  await sleep(1000);
  const takenNow = await taken();
  check('A2  wygasła rezerwacja znika z takenSeats', !takenNow.includes(seatExpire));

  const b4 = await reserve(seatAfter, 400);
  check('B4  po wygaśnięciu ktoś inny rezerwuje', b4.ok, b4.status);

  const c4 = await purchase(rLate.data.reservationId);
  check('C4  zakup po czasie', is4xx(c4), c4.status);
  check('C4  kupione miejsce dalej zajęte', takenNow.includes(seatBought));

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
