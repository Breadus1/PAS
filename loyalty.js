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

async function savedCode(db, email) {
  const { rows } = await db.query('SELECT member_id FROM loyalty_members WHERE email = $1', [email]);
  return rows[0] ? rows[0].member_id : null;
}

function saveCode(db, email, code) {
  return db.query('INSERT INTO loyalty_members (email, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [email, code]);
}

function adjust(code, points) {
  return voucherify('POST', `/v1/loyalties/members/${encodeURIComponent(code)}/balance`, { points });
}

async function findCard(db, email) {
  const code = await savedCode(db, email);
  if (code) {
    return voucherify('GET', `/v1/loyalties/members/${encodeURIComponent(code)}`);
  }

  const list = await voucherify('GET', `/v1/loyalties/${CAMPAIGN_ID}/members?customer=${encodeURIComponent(email)}`);
  const card = list.vouchers[0];
  if (card) {
    await saveCode(db, email, card.code);
  }
  return card || null;
}

async function createCard(db, email, extraPoints) {
  const card = await voucherify('POST', `/v1/loyalties/${CAMPAIGN_ID}/members`, {
    customer: { source_id: email, email },
  });

  const bonus = card.loyalty_card.balance === 0 ? WELCOME_POINTS + extraPoints : extraPoints;
  if (bonus !== 0) {
    const result = await adjust(card.code, bonus);
    card.loyalty_card.balance = result.balance;
  }

  await saveCode(db, email, card.code);
  return card;
}

async function getBalance(db, email) {
  const card = await findCard(db, normalize(email));
  return card ? card.loyalty_card.balance : WELCOME_POINTS;
}

async function spendPoints(db, email, points) {
  const customer = normalize(email);
  const card = (await findCard(db, customer)) || (await createCard(db, customer, 0));
  if (card.loyalty_card.balance < points) {
    return false;
  }
  await adjust(card.code, -points);
  return true;
}

async function addPoints(db, email, points) {
  const customer = normalize(email);
  const code = (await savedCode(db, customer)) || ((await findCard(db, customer)) || {}).code;
  if (code) {
    await adjust(code, points);
  } else {
    await createCard(db, customer, points);
  }
}

module.exports = { getBalance, spendPoints, addPoints, normalize };
