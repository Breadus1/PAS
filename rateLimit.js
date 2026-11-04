const LIMIT = 30;
const WINDOW_MS = 10 * 1000;

const clients = new Map();

function rateLimit(req, res, next) {
  const now = Date.now();
  let client = clients.get(req.ip);

  if (!client || now >= client.resetAt) {
    client = { count: 0, resetAt: now + WINDOW_MS };
    clients.set(req.ip, client);
  }

  client.count++;

  if (client.count > LIMIT) {
    const seconds = Math.ceil((client.resetAt - now) / 1000);
    res.set('Retry-After', String(seconds));
    return res.status(429).json({ error: 'Za dużo rezerwacji, spróbuj za chwilę' });
  }

  next();
}

module.exports = rateLimit;
