import { planFor, todayParis } from "../lib/calendar.js";

const env = (k, d) => process.env[k] ?? d;

// Libellés bancaires sans accent (22 caractères max)
const MONTHS = ["JANV", "FEVR", "MARS", "AVR", "MAI", "JUIN", "JUIL", "AOUT", "SEPT", "OCT", "NOV", "DEC"];
const MONTHS_FULL = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

export function labels(year, month) {
  const short = `${MONTHS[month - 1]} ${year}`;
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
  return {
    urssaf: { descriptor: `URSSAF CA ${short}`, description: `Provision URSSAF : CA de ${MONTHS_FULL[month - 1]} ${year}, à déclarer en ${MONTHS_FULL[next.m - 1]} ${next.y}` },
    net: { descriptor: `CA NET ${short}`, description: `CA net de ${MONTHS_FULL[month - 1]} ${year} (après provision URSSAF)` },
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

async function createPayout(kind, amount, currency, monthKey, label, destination) {
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
      ...(destination ? { destination } : {}),
    },
    `${kind}-${monthKey}`,
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
  const pct = Number(env("URSSAF_PCT", "30"));
  const lab = labels(y, m);

  // Quels virements existent déjà pour ce mois ?
  const recent = await stripe("/payouts?limit=50");
  const done = (kind) =>
    recent.data.some((p) => p.metadata?.month === monthKey && p.metadata?.kind === kind && !["failed", "canceled"].includes(p.status));
  const urssafDone = done("urssaf");
  const netDone = done("net");
  if (urssafDone && netDone) return Response.json({ action: "already-done", month: monthKey });

  const balance = await stripe("/balance");
  const available = balance.available.find((b) => b.currency === currency)?.amount ?? 0; // centimes

  // Cas normal : les deux virements partent du même solde. Cas partiel : on arrête et on signale.
  if (urssafDone !== netDone) {
    return Response.json({ action: "partial-state-check-manually", month: monthKey, urssafDone, netDone, available }, { status: 409 });
  }

  const urssafAmount = Math.floor((available * pct) / 100);
  const netAmount = available - urssafAmount;
  const min = Number(env("MIN_PAYOUT_CENTS", "100"));
  const summary = { today, month: monthKey, ...plan, available, urssafAmount, netAmount, pct, labels: { urssaf: lab.urssaf.descriptor, net: lab.net.descriptor } };
  console.log("monthly-payout", JSON.stringify(summary));

  if (available < min * 2) return Response.json({ action: "skip-too-small", ...summary });
  if (env("DRY_RUN", "true") === "true") return Response.json({ action: "dry-run", ...summary });

  const urssaf = await createPayout("urssaf", urssafAmount, currency, monthKey, lab.urssaf, env("PAYOUT_DESTINATION_URSSAF"));
  const net = await createPayout("net", netAmount, currency, monthKey, lab.net, env("PAYOUT_DESTINATION_NET"));
  return Response.json({
    action: "paid-out",
    urssaf: { id: urssaf.id, arrival_date: urssaf.arrival_date },
    net: { id: net.id, arrival_date: net.arrival_date },
    ...summary,
  });
}
