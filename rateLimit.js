function rateLimit(limit, windowMs) {
  const clients = new Map();

  return (req, res, next) => {
    const now = Date.now();
    let client = clients.get(req.ip);

    if (!client || now >= client.resetAt) {
      client = { count: 0, resetAt: now + windowMs };
      clients.set(req.ip, client);
    }

    client.count++;

    if (client.count > limit) {
      const seconds = Math.ceil((client.resetAt - now) / 1000);
      res.set('Retry-After', String(seconds));
      return res.status(429).json({ error: 'Za dużo zapytań, spróbuj za chwilę' });
    }

    next();
  };
}

module.exports = rateLimit;
