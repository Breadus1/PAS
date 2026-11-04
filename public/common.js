function formatDate(isoDate) {
  return new Date(isoDate).toLocaleString('pl-PL', {
    timeZone: 'Europe/Warsaw',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatPrice(amount) {
  return (amount / 100).toLocaleString('pl-PL', {
    style: 'currency',
    currency: 'PLN',
    minimumFractionDigits: 0,
  });
}

function seatLabel(seatId) {
  return `Rząd ${seatId[0]}, miejsce ${seatId.slice(1)}`;
}
