import { planFor, todayParis } from "../lib/calendar.js";

const env = (k, d) => process.env[k] ?? d;

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

// Appelé chaque jour par le cron Vercel. N'agit que le jour d'envoi calculé (ou en rattrapage).
export async function GET(request) {
  // Vercel envoie "Authorization: Bearer $CRON_SECRET" si CRON_SECRET est défini
  const secret = env("CRON_SECRET");
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }

  const today = todayParis();
  const [y, m] = today.split("-").map(Number);
  const lead = Number(env("LEAD_BUSINESS_DAYS", "3"));
  const plan = planFor(y, m, lead);
  const monthKey = `${y}-${String(m).padStart(2, "0")}`;
  const force = new URL(request.url).searchParams.get("force") === "1";

  // Pas encore le jour d'envoi
  if (today < plan.send && !force) {
    return Response.json({ action: "wait", today, ...plan });
  }

  const currency = env("CURRENCY", "eur");
  const pct = Number(env("URSSAF_PCT", "30"));

  // Déjà fait ce mois-ci ? (metadata sur les virements récents)
  const recent = await stripe("/payouts?limit=30");
  if (recent.data.some((p) => p.metadata?.urssaf_month === monthKey && p.status !== "failed" && p.status !== "canceled")) {
    return Response.json({ action: "already-done", month: monthKey });
  }

  const balance = await stripe("/balance");
  const available = balance.available.find((b) => b.currency === currency)?.amount ?? 0; // centimes
  const amount = Math.floor((available * pct) / 100);
  const min = Number(env("MIN_PAYOUT_CENTS", "100"));

  const summary = { today, month: monthKey, ...plan, available, amount, pct };
  console.log("monthly-payout", JSON.stringify(summary));

  if (amount < min) return Response.json({ action: "skip-too-small", ...summary });
  if (env("DRY_RUN", "true") === "true") return Response.json({ action: "dry-run", ...summary });

  const payout = await stripe(
    "/payouts",
    "POST",
    {
      amount: String(amount),
      currency,
      description: `Provision URSSAF ${monthKey}`,
      // Libellé visible sur le relevé bancaire (22 caractères max)
      statement_descriptor: `URSSAF ${monthKey}`,
      "metadata[urssaf_month]": monthKey,
      ...(env("PAYOUT_DESTINATION") ? { destination: env("PAYOUT_DESTINATION") } : {}),
    },
    `urssaf-${monthKey}`,
  );
  return Response.json({ action: "paid-out", payoutId: payout.id, arrival_date: payout.arrival_date, ...summary });
}
