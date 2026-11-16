import { planFor, todayParis } from "../lib/calendar.js";
import { makeTaxFn } from "../lib/tax.js";

const env = (k, d) => process.env[k] ?? d;

// Libellés bancaires sans accent (22 caractères max)
const MONTHS = ["JANV", "FEVR", "MARS", "AVR", "MAI", "JUIN", "JUIL", "AOUT", "SEPT", "OCT", "NOV", "DEC"];
const MONTHS_FULL = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

export function labels(year, month) {
  const short = `${MONTHS[month - 1]} ${year}`;
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
  return {
    urssaf: { descriptor: `URSSAF CA ${short}`, description: `Provision URSSAF : CA de ${MONTHS_FULL[month - 1]} ${year}, à déclarer en ${MONTHS_FULL[next.m - 1]} ${next.y}` },
    dette: { descriptor: `URSSAF DETTE ${short}`, description: `Remboursement dette URSSAF (réserve atteinte en ${MONTHS_FULL[month - 1]} ${year})` },
    impots: { descriptor: `IMPOTS REVENU ${year}`, description: `Provision impôt sur le revenu ${year}, à payer lors de la déclaration` },
    net: { descriptor: `CA NET ${short}`, description: `CA net de ${MONTHS_FULL[month - 1]} ${year} (après provision URSSAF)` },
  };
}

/**
 * Calcul pur (testable). Tous les montants en centimes.
 *  C = CA encaissé depuis le dernier envoi, A = solde disponible,
 *  reservePrev = réserve dette déjà mise de côté dans Stripe.
 */
export function computeRun({
  C, A, reservePrev = 0, pct = 30, debtPct = 10, target = 0, min = 100, debtDone = false,
  ytd = 0, taxReserve = 0, taxFn = null, taxPayoutNow = false,
}) {
  if (debtDone) target = 0; // dette déjà remboursée : plus de réserve
  const U = Math.max(0, Math.min(Math.floor((C * pct) / 100), A));
  let D = 0;
  if (target > 0 && reservePrev < target) {
    D = Math.max(0, Math.min(Math.floor((C * debtPct) / 100), target - reservePrev, A - U));
  }
  const reserveNew = reservePrev + D;
  let debtPayout = 0, held = reserveNew;
  if (target > 0 && reserveNew >= target) {
    debtPayout = Math.min(reserveNew, A - U);
    held = reserveNew - debtPayout;
  }

  // Impôt sur le revenu : réserve cumulée = impôt estimé sur le CA cumulé de l'année
  let T = 0;
  if (taxFn) {
    const wanted = Math.max(0, taxFn(ytd + C) - taxReserve);
    T = Math.max(0, Math.min(wanted, A - U - D - reservePrev - taxReserve));
  }
  const taxReserveNew = taxReserve + T;
  const taxPay = taxPayoutNow ? Math.min(taxReserveNew, Math.max(0, A - U - debtPayout)) : 0;
  const taxHeld = taxReserveNew - taxPay;

  const rest = Math.max(0, A - U - debtPayout - taxPay);
  const N = Math.max(0, rest - Math.min(held + taxHeld, rest));
  return {
    urssaf: U >= min ? U : 0,
    dette: debtPayout >= min ? debtPayout : 0,
    impots: taxPay >= min ? taxPay : 0,
    net: N >= min ? N : 0,
    heldAfter: held,
    debtAdded: D,
    taxHeld,
    taxAdded: T,
    ytdAfter: ytd + C,
  };
}

async function stripe(path, method = "GET", body, idempotencyKey) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env("STRIPE_SECRET_KEY")}`,
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: body ? new URLSearchParams(body).toString() : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Stripe ${method} ${path} -> ${res.status} ${JSON.stringify(json.error ?? json)}`);
  return json;
}

// Timestamp UNIX (secondes) de minuit à Paris pour un jour donné
export function parisMidnight(y, m, d) {
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const off = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris", timeZoneName: "shortOffset" })
    .formatToParts(new Date(guess)).find((p) => p.type === "timeZoneName").value; // ex: "GMT+1"
  const hours = Number((off.match(/GMT([+-]\d+)/) || [0, 0])[1]);
  return Math.floor((guess - hours * 3600000) / 1000);
}

// CA brut encaissé entre deux instants (date du paiement), remboursements déduits, en centimes
async function revenueBetween(from, to, currency) {
  let total = 0, startingAfter;
  for (let i = 0; i < 50; i++) {
    const q = `/balance_transactions?limit=100&created[gt]=${from}&created[lte]=${to}&currency=${currency}${startingAfter ? `&starting_after=${startingAfter}` : ""}`;
    const page = await stripe(q);
    for (const t of page.data) {
      // remboursements et litiges perdus sont négatifs ; litige gagné (dispute_reversal) redevient positif
      const cat = t.reporting_category ?? t.type;
      if (["charge", "payment", "refund", "payment_refund", "dispute", "dispute_reversal"].includes(cat)) total += t.amount;
    }
    if (!page.has_more) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return total;
}

function createPayout(kind, amount, currency, monthKey, label, destination, meta) {
  return stripe(
    "/payouts",
    "POST",
    {
      amount: String(amount),
      currency,
      description: label.description,
      statement_descriptor: label.descriptor,
      "metadata[month]": monthKey,
      "metadata[kind]": kind,
      "metadata[cutoff]": String(meta.cutoff),
      "metadata[debt_reserve]": String(meta.held),
      "metadata[debt_done]": meta.debtDone ? "1" : "0",
      "metadata[count]": String(meta.count),
      "metadata[tax_reserve]": String(meta.taxHeld),
      "metadata[ytd]": String(meta.ytd),
      "metadata[tax_year]": String(meta.taxYear),
      ...(destination ? { destination } : {}),
    },
    `${kind}-${monthKey}-${meta.cutoff}`,
  );
}

// Appelé chaque jour par le cron Vercel. N'agit que le jour d'envoi calculé (ou en rattrapage).
export async function GET(request) {
  const secret = env("CRON_SECRET");
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }

  const today = todayParis();
  const [y, m] = today.split("-").map(Number);
  const plan = planFor(y, m, Number(env("LEAD_BUSINESS_DAYS", "3")));
  const monthKey = `${y}-${String(m).padStart(2, "0")}`;
  const force = new URL(request.url).searchParams.get("force") === "1";

  if (today < plan.send && !force) return Response.json({ action: "wait", today, ...plan });

  const currency = env("CURRENCY", "eur");
  const lab = labels(y, m);
  const now = Math.floor(Date.now() / 1000);

  // État reconstruit depuis les virements passés (aucune base de données)
  const recent = (await stripe("/payouts?limit=100")).data.filter((p) => !["failed", "canceled"].includes(p.status));
  const thisMonth = recent.filter((p) => p.metadata?.month === monthKey);
  if (thisMonth.length) {
    const expected = Number(thisMonth[0].metadata.count || 0);
    if (thisMonth.length >= expected) return Response.json({ action: "already-done", month: monthKey });
    return Response.json({ action: "partial-state-check-manually", month: monthKey, found: thisMonth.length, expected }, { status: 409 });
  }
  const last = recent.find((p) => p.metadata?.cutoff);
  const startDefault = env("START_DATE") ? env("START_DATE").split("-").map(Number) : [y, m, 1];
  const periodStart = last ? Number(last.metadata.cutoff) : parisMidnight(...startDefault);
  const debtDone = recent.some((p) => p.metadata?.kind === "dette") || last?.metadata?.debt_done === "1" || env("DEBT_DONE") === "true";
  const reservePrev = last ? Number(last.metadata.debt_reserve || 0) : Number(env("DEBT_RESERVE_START_CENTS", "0"));

  // Impôt : CA cumulé de l'année civile + réserve déjà constituée
  const sameYear = last && Number(last.metadata.tax_year) === y;
  const ytd = sameYear ? Number(last.metadata.ytd || 0) : (last ? 0 : Number(env("YTD_START_CENTS", "0")));
  const taxReserve = last ? Number(last.metadata.tax_reserve || 0) : 0;
  const taxOn = env("TAX_ENABLED", "true") === "true";
  const taxFn = taxOn ? makeTaxFn({
    abatement: Number(env("TAX_ABATEMENT_PCT", "34")),
    parts: Number(env("TAX_PARTS", "1")),
    couple: env("TAX_COUPLE", "false") === "true",
    otherIncomeCents: Number(env("TAX_OTHER_INCOME_CENTS", "0")),
  }) : null;
  const taxPayoutNow = taxOn && m === Number(env("TAX_PAYOUT_MONTH", "12"));

  const C = await revenueBetween(periodStart, now, currency);
  const balance = await stripe("/balance");
  const A = balance.available.find((b) => b.currency === currency)?.amount ?? 0;

  const r = computeRun({
    C, A, reservePrev, debtDone, ytd, taxReserve, taxFn, taxPayoutNow,
    pct: Number(env("URSSAF_PCT", "30")),
    debtPct: Number(env("DEBT_PCT", "10")),
    target: Number(env("DEBT_TARGET_CENTS", "0")),
    min: Number(env("MIN_PAYOUT_CENTS", "100")),
  });
  const kinds = ["urssaf", "dette", "impots", "net"].filter((k) => r[k] > 0);
  const summary = { today, month: monthKey, ...plan, periodStart, revenue: C, available: A, reservePrev, ...r };
  console.log("monthly-payout", JSON.stringify(summary));

  if (!kinds.length) return Response.json({ action: "nothing-to-pay", ...summary });
  if (env("DRY_RUN", "true") === "true") return Response.json({ action: "dry-run", will_pay: kinds, ...summary });

  const dest = { urssaf: env("PAYOUT_DESTINATION_URSSAF"), dette: env("PAYOUT_DESTINATION_URSSAF"), impots: env("PAYOUT_DESTINATION_NET"), net: env("PAYOUT_DESTINATION_NET") };
  const meta = { cutoff: now, held: r.heldAfter, count: kinds.length, debtDone: debtDone || r.dette > 0, taxHeld: r.taxHeld, ytd: r.ytdAfter, taxYear: y };
  const results = {};
  for (const k of kinds) {
    const p = await createPayout(k, r[k], currency, monthKey, lab[k], dest[k], meta);
    results[k] = { id: p.id, amount: r[k], arrival_date: p.arrival_date };
  }
  return Response.json({ action: "paid-out", results, ...summary });
}
