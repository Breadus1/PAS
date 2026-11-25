const API_URL = process.env.VOUCHERIFY_API_URL || 'https://api.voucherify.io';
const CAMPAIGN_ID = process.env.VOUCHERIFY_CAMPAIGN_ID;
const WELCOME_POINTS = 1000;

async function voucherify(method, path, body) {
  if (!process.env.VOUCHERIFY_APP_ID || !process.env.VOUCHERIFY_SECRET_KEY || !CAMPAIGN_ID) {
    throw new Error('Brak kluczy Voucherify');
  }

  const res = await fetch(API_URL + path, {
    method,
    headers: {
      'X-App-Id': process.env.VOUCHERIFY_APP_ID,
      'X-App-Token': process.env.VOUCHERIFY_SECRET_KEY,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    throw new Error(`Voucherify ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

function normalize(email) {
  return email.trim().toLowerCase();
}

async function findMember(db, email) {
  const { rows } = await db.query('SELECT member_id FROM loyalty_members WHERE email = $1', [email]);
  if (rows[0]) {
    return rows[0].member_id;
  }

  const list = await voucherify('GET', `/v1/loyalties/${CAMPAIGN_ID}/members?customer=${encodeURIComponent(email)}`);
  const card = list.vouchers[0];
  if (!card) {
    return null;
  }

  await db.query('INSERT INTO loyalty_members (email, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [email, card.code]);
  return card.code;
}

async function createMember(db, email) {
  const card = await voucherify('POST', `/v1/loyalties/${CAMPAIGN_ID}/members`, {
    customer: { source_id: email, email },
  });

  if (card.loyalty_card.balance === 0) {
    await voucherify('POST', `/v1/loyalties/members/${encodeURIComponent(card.code)}/balance`, {
      points: WELCOME_POINTS,
    });
  }

  await db.query('INSERT INTO loyalty_members (email, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [email, card.code]);
  return card.code;
}

async function getBalance(db, email) {
  const memberId = await findMember(db, normalize(email));
  if (!memberId) {
    return WELCOME_POINTS;
  }

  const card = await voucherify('GET', `/v1/loyalties/members/${encodeURIComponent(memberId)}`);
  return card.loyalty_card.balance;
}

async function changePoints(db, email, points) {
  const customer = normalize(email);
  const memberId = (await findMember(db, customer)) || (await createMember(db, customer));
  const result = await voucherify('POST', `/v1/loyalties/members/${encodeURIComponent(memberId)}/balance`, { points });
  return result.balance;
}

module.exports = { getBalance, changePoints, normalize };
