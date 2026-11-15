// Jours ouvrés (France + TARGET2/SEPA) et calcul de la date d'envoi du virement mensuel.
// Toutes les dates sont manipulées en "YYYY-MM-DD" (calendrier, sans fuseau) pour éviter les décalages.

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

// Dimanche de Pâques (algorithme de Meeus/Jones/Butcher)
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(y, month, day);
}

// Jours non ouvrés en semaine : fériés français + Vendredi saint et 26/12 (fermeture TARGET2),
// par prudence : on préfère envoyer trop tôt que trop tard.
export function holidays(y) {
  const e = easter(y);
  return new Set([
    `${y}-01-01`, `${y}-05-01`, `${y}-05-08`, `${y}-07-14`, `${y}-08-15`,
    `${y}-11-01`, `${y}-11-11`, `${y}-12-25`, `${y}-12-26`,
    iso(addDays(e, -2)), // Vendredi saint
    iso(addDays(e, 1)),  // Lundi de Pâques
    iso(addDays(e, 39)), // Ascension
    iso(addDays(e, 50)), // Lundi de Pentecôte
  ]);
}

export function isBusinessDay(d) {
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !holidays(d.getUTCFullYear()).has(iso(d));
}

export function lastBusinessDayOfMonth(year, month) {
  let d = utc(year, month + 1, 0); // dernier jour du mois
  while (!isBusinessDay(d)) d = addDays(d, -1);
  return d;
}

export function subtractBusinessDays(d, n) {
  let cur = d;
  while (n > 0) {
    cur = addDays(cur, -1);
    if (isBusinessDay(cur)) n--;
  }
  return cur;
}

/**
 * Pour un mois donné :
 *  - arrival : jour où l'argent doit être arrivé = dernier jour ouvré du mois
 *  - send    : jour où lancer le virement = arrival - leadDays jours ouvrés
 */
export function planFor(year, month, leadDays = 3) {
  const arrival = lastBusinessDayOfMonth(year, month);
  const send = subtractBusinessDays(arrival, leadDays);
  return { arrival: iso(arrival), send: iso(send) };
}

// Date du jour en France (YYYY-MM-DD)
export function todayParis(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(now);
  return parts; // en-CA => YYYY-MM-DD
}
