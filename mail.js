const FROM = process.env.EMAIL_FROM || 'KinoBilet <onboarding@resend.dev>';

function escapeHtml(text) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(text).replace(/[&<>"']/g, (char) => entities[char]);
}

function zl(amount) {
  return `${(amount / 100).toFixed(2).replace('.', ',')} zł`;
}

async function sendTicket(reservation, event) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('Brak klucza Resend');
  }

  const date = new Date(event.startsAt).toLocaleString('pl-PL', {
    timeZone: 'Europe/Warsaw',
    dateStyle: 'full',
    timeStyle: 'short',
  });
  const seat = reservation.seat_id;

  const html = `
    <p>Cześć ${escapeHtml(reservation.customer_name)},</p>
    <h1>${escapeHtml(event.title)}</h1>
    <p>${date}, ${event.hall}, rząd ${seat[0]}, miejsce ${seat.slice(1)}</p>
    <p>Kod biletu: <strong style="font-size: 28px; letter-spacing: 4px">${reservation.code}</strong></p>
    <p>Pokaż ten kod przy wejściu na salę.</p>
    <h2>Podsumowanie</h2>
    <ul>
      <li>Zapłacono kartą: ${zl(reservation.amount - reservation.points_used)}</li>
      <li>Zapłacono punktami: ${reservation.points_used} pkt (${zl(reservation.points_used)})</li>
      <li>Zebrane punkty: ${reservation.points_earned} pkt</li>
    </ul>
  `;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `bilet-${reservation.id}`,
    },
    body: JSON.stringify({
      from: FROM,
      to: [reservation.email],
      subject: `Twój bilet: ${event.title}`,
      html,
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    throw new Error(`Resend ${res.status}: ${await res.text()}`);
  }
}

module.exports = { sendTicket };
