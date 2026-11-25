const crypto = require('crypto');

const FROM = process.env.EMAIL_FROM || 'KinoBilet <onboarding@resend.dev>';

function escapeHtml(text) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(text).replace(/[&<>"']/g, (char) => entities[char]);
}

function zl(amount) {
  return `${(amount / 100).toFixed(2).replace('.', ',')} zł`;
}

function warsaw(date, options) {
  return new Date(date).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw', ...options });
}

function seatText(event, seatId) {
  const date = warsaw(event.startsAt, { dateStyle: 'full', timeStyle: 'short' });
  return `${date}, ${event.hall}, rząd ${seatId[0]}, miejsce ${seatId.slice(1)}`;
}

async function send(to, subject, html, idempotencyKey) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('Brak klucza Resend');
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ from: FROM, to: [to], subject, html }),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    throw new Error(`Resend ${res.status}: ${await res.text()}`);
  }
  return (await res.json()).id;
}

function sendTicket(reservation, event) {
  const html = `
    <p>Cześć ${escapeHtml(reservation.customer_name)},</p>
    <h1>${escapeHtml(event.title)}</h1>
    <p>${seatText(event, reservation.seat_id)}</p>
    <p>Kod biletu: <strong style="font-size: 28px; letter-spacing: 4px">${reservation.code}</strong></p>
    <p>Pokaż ten kod przy wejściu na salę.</p>
    <h2>Podsumowanie</h2>
    <ul>
      <li>Zapłacono kartą: ${zl(reservation.amount - reservation.points_used)}</li>
      <li>Zapłacono punktami: ${reservation.points_used} pkt (${zl(reservation.points_used)})</li>
      <li>Zebrane punkty: ${reservation.points_earned} pkt</li>
    </ul>
  `;
  return send(reservation.email, `Twój bilet: ${event.title}`, html, `bilet-${reservation.id}`);
}

function sendOffer(entry, reservation, event, link) {
  const until = warsaw(reservation.expires_at, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  const html = `
    <p>Cześć ${escapeHtml(entry.customer_name)},</p>
    <p>Zwolniło się miejsce na seans, na który czekasz na liście oczekujących:</p>
    <h1>${escapeHtml(event.title)}</h1>
    <p>${seatText(event, reservation.seat_id)}</p>
    <p>Miejsce czeka na Ciebie do <strong>${until}</strong>. Zapłać kartą albo częściowo punktami:</p>
    <p><a href="${link}">${link}</a></p>
    <p>Jeśli nie zapłacisz do tej godziny, miejsce dostanie następna osoba z kolejki.</p>
  `;
  return send(entry.email, `Zwolniło się miejsce: ${event.title}`, html, `oferta-${entry.id}`);
}

function verifyWebhook(body, headers) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  const id = headers['svix-id'];
  const timestamp = headers['svix-timestamp'];
  const signatures = headers['svix-signature'];

  if (!secret || !id || !timestamp || !signatures || !Buffer.isBuffer(body)) {
    return false;
  }
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 5 * 60) {
    return false;
  }

  const key = Buffer.from(secret.replace('whsec_', ''), 'base64');
  const expected = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');

  return signatures.split(' ').some((part) => {
    const signature = part.split(',')[1] || '';
    return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  });
}

module.exports = { sendTicket, sendOffer, verifyWebhook };
