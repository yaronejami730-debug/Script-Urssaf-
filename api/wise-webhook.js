import crypto from "node:crypto";

const env = (k, d) => process.env[k] ?? d;

function verifySignature(rawBody, signature) {
  // Paste Wise's webhook public key (from Wise docs, live or sandbox) in WISE_WEBHOOK_PUBLIC_KEY
  const key = (env("WISE_WEBHOOK_PUBLIC_KEY") || "").replace(/\\n/g, "\n");
  if (!key || !signature) return false;
  const v = crypto.createVerify("RSA-SHA256");
  v.update(rawBody);
  return v.verify(key, signature, "base64");
}

async function wise(path, method, body) {
  const res = await fetch(`${env("WISE_API_BASE", "https://api.wise.com")}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env("WISE_API_TOKEN")}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`Wise ${method} ${path} -> ${res.status} ${text}`);
  return json;
}

// Deterministic UUID from a string => Wise dedupes transfers on customerTransactionId
function uuidFrom(str) {
  const h = crypto.createHash("sha256").update(str).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function POST(request) {
  const raw = await request.text();

  if (!verifySignature(raw, request.headers.get("x-signature-sha256"))) {
    return new Response("bad signature", { status: 401 });
  }

  const event = JSON.parse(raw);
  if (event.event_type !== "balances#credit") return new Response("ignored", { status: 200 });

  const d = event.data;
  const currency = env("CURRENCY", "EUR");
  if (d.currency !== currency || d.transaction_type !== "credit") {
    return new Response("ignored (currency/type)", { status: 200 });
  }

  const minAmount = Number(env("MIN_AMOUNT", "1"));
  if (d.amount < minAmount) return new Response("ignored (too small)", { status: 200 });

  // Share sent to Revolut. Default 70% -> 30% stays on Wise for URSSAF.
  const keepPct = Number(env("URSSAF_PCT", "30"));
  const toSend = Math.floor(d.amount * (100 - keepPct)) / 100;
  const profileId = d.resource?.profile_id ?? env("WISE_PROFILE_ID");
  const eventKey = request.headers.get("x-delivery-id") || `${d.resource?.id}:${d.occurred_at}:${d.amount}`;

  console.log(`credit ${d.amount} ${currency} -> send ${toSend}, keep ${(d.amount - toSend).toFixed(2)}`);

  if (env("DRY_RUN") === "true") {
    return Response.json({ dryRun: true, received: d.amount, toSend });
  }

  try {
    const quote = await wise(`/v3/profiles/${profileId}/quotes`, "POST", {
      sourceCurrency: currency,
      targetCurrency: currency,
      sourceAmount: toSend,
      targetAccount: Number(env("WISE_RECIPIENT_ID")),
    });

    const transfer = await wise(`/v1/transfers`, "POST", {
      targetAccount: Number(env("WISE_RECIPIENT_ID")),
      quoteUuid: quote.id,
      customerTransactionId: uuidFrom(eventKey),
      details: { reference: env("TRANSFER_REFERENCE", "Perso") },
    });

    // Fund from balance. NOTE: in EU/UK this may require SCA (see README).
    const payment = await wise(`/v3/profiles/${profileId}/transfers/${transfer.id}/payments`, "POST", {
      type: "BALANCE",
    });

    return Response.json({ ok: true, transferId: transfer.id, status: payment.status });
  } catch (e) {
    console.error(e);
    // 500 => Wise retries the webhook; transfer is idempotent via customerTransactionId
    return new Response(String(e.message), { status: 500 });
  }
}

export function GET() {
  return new Response("wise-urssaf-split alive");
}
