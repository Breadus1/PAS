const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.on('error', (err) => {
  console.error('Baza:', err.message);
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      seat_id TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      email TEXT NOT NULL,
      amount INTEGER NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'held',
      code TEXT,
      checkout_url TEXT,
      points_used INTEGER NOT NULL DEFAULT 0,
      points_earned INTEGER,
      points_awarded BOOLEAN NOT NULL DEFAULT false,
      points_returned BOOLEAN NOT NULL DEFAULT false,
      email_sent BOOLEAN NOT NULL DEFAULT false,
      email_attempts INTEGER NOT NULL DEFAULT 0
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS reservations_seat ON reservations (event_id, seat_id)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS loyalty_members (
      email TEXT PRIMARY KEY,
      member_id TEXT NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS waitlist (
      id TEXT PRIMARY KEY,
      seq BIGSERIAL,
      event_id TEXT NOT NULL,
      email TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting',
      reservation_id TEXT,
      email_sent BOOLEAN NOT NULL DEFAULT false,
      email_id TEXT
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS waitlist_event ON waitlist (event_id, status)');
}

function query(text, params) {
  return pool.query(text, params);
}

async function transaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function lock(client, key) {
  return client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
}

module.exports = { init, query, transaction, lock };
