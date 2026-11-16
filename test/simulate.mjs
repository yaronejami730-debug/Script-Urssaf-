// Simulation locale : faux serveur Stripe + horloge simulée. Aucune clé, aucun appel réseau.
// Lancer : node test/simulate.mjs
import assert from "node:assert/strict";

// ---------- Horloge simulée ----------
let fakeNow = Date.UTC(2026, 10, 1, 7, 0, 0);
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(fakeNow); }
  static now() { return fakeNow; }
};

// ---------- Faux Stripe ----------
const DAY = 86400;
const state = { payments: [], payouts: [], idem: new Map(), n: 0 };
const nowS = () => Math.floor(fakeNow / 1000);
const fee = (g) => Math.round(g * 0.015) + 25;
const netOf = (p) => p.amount - fee(p.amount);
const available = () =>
  state.payments.filter((p) => p.created <= nowS() - 2 * DAY).reduce((s, p) => s + netOf(p), 0) -
  state.payouts.filter((p) => p.status !== "canceled").reduce((s, p) => s + p.amount, 0);

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const path = u.pathname.replace("/v1", "");
  const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status });
  const method = init.method || "GET";

  if (path === "/balance") return reply({ available: [{ currency: "eur", amount: available() }] });

  if (path === "/balance_transactions") {
    const gt = Number(u.searchParams.get("created[gt]")), lte = Number(u.searchParams.get("created[lte]"));
    const data = state.payments.filter((p) => p.created > gt && p.created <= lte)
      .map((p) => ({ id: p.id, type: p.type || "charge", amount: p.amount, fee: fee(p.amount), net: netOf(p), created: p.created }));
    return reply({ data, has_more: false });
  }

  if (path === "/payouts" && method === "GET") {
    return reply({ data: [...state.payouts].sort((a, b) => b.created - a.created || b.seq - a.seq) });
  }

  if (path === "/payouts" && method === "POST") {
    const key = init.headers["Idempotency-Key"];
    if (key && state.idem.has(key)) return reply(state.idem.get(key));
    const b = new URLSearchParams(init.body);
    const amount = Number(b.get("amount"));
    if (amount > available()) return reply({ error: { message: "insufficient funds" } }, 400);
    const metadata = {};
    for (const [k, v] of b) { const m = k.match(/^metadata\[(.+)\]$/); if (m) metadata[m[1]] = v; }
    const p = {
      id: `po_${++state.n}`, seq: state.n, amount, status: "pending", created: nowS(),
      description: b.get("description"), statement_descriptor: b.get("statement_descriptor"),
      metadata, arrival_date: nowS() + 2 * DAY,
    };
    assert.ok(p.statement_descriptor.length <= 22, `libellé trop long: ${p.statement_descriptor}`);
    assert.match(p.statement_descriptor, /^[A-Z0-9 ]+$/, "libellé: caractères non autorisés");
    state.payouts.push(p);
    if (key) state.idem.set(key, p);
    return reply(p);
  }
  return reply({ error: { message: `unmocked ${method} ${path}` } }, 404);
};

// ---------- Config ----------
process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.CRON_SECRET = "s3cret";
process.env.DEBT_TARGET_CENTS = "100000";
process.env.DEBT_PCT = "15";
process.env.START_DATE = "2026-11-01";
process.env.DRY_RUN = "false";

const { GET } = await import("../api/monthly-payout.js");
const call = async (qs = "", auth = "Bearer s3cret") =>
  GET(new Request(`https://x/api/monthly-payout${qs}`, { headers: auth ? { authorization: auth } : {} }));
const eur = (c) => (c / 100).toFixed(2) + "€";

// ---------- Test 1 : sécurité ----------
assert.equal((await call("", null)).status, 401);
assert.equal((await call("", "Bearer wrong")).status, 401);
console.log("✓ sans le bon secret : refusé (401)");

// ---------- Test 2 : simulation de 8 mois, jour par jour ----------
// Clients : abonnement 300€ le 5, 100€ le 10 et le 20, 500€ le 29 (tombe dans la fin de mois)
const pay = (y, m, d, amount) => state.payments.push({ id: `ch_${state.payments.length + 1}`, amount, created: Math.floor(Date.UTC(y, m - 1, d, 12) / 1000) });
for (let k = 0; k < 16; k++) {
  const y = 2026 + Math.floor((10 + k) / 12), m = ((10 + k) % 12) + 1;
  pay(y, m, 5, 30000); pay(y, m, 10, 10000); pay(y, m, 20, 10000); pay(y, m, 29, 50000);
}
let grossCounted = 0, urssafTotal = 0, detteTotal = 0, netTotal = 0, runs = 0;
const log = [];
for (let day = Date.UTC(2026, 10, 1, 7); day < Date.UTC(2028, 3, 30, 7); day += 86400000) {
  fakeNow = day;
  const r = await call();
  const j = await r.json();
  if (r.status === 409) assert.fail("état partiel inattendu");
  if (j.action === "paid-out") {
    runs++;
    urssafTotal += j.results.urssaf?.amount ?? 0;
    detteTotal += j.results.dette?.amount ?? 0;
    netTotal += j.results.net?.amount ?? 0;
    log.push(`${j.today} (arrivée visée ${j.arrival}) CA période ${eur(j.revenue)} → URSSAF ${eur(j.results.urssaf?.amount ?? 0)}` +
      ` | DETTE ${eur(j.results.dette?.amount ?? 0)} | NET ${eur(j.results.net?.amount ?? 0)} | réserve ${eur(j.heldAfter)}`);
  }
  // Un 2e appel le même jour ne doit rien refaire
  if (j.action === "paid-out") assert.equal((await (await call()).json()).action, "already-done");
}
console.log("\n" + log.join("\n").replace(/^/gm,"  "));

// ---------- Vérifications globales ----------
const last = [...state.payouts].sort((a, b) => b.created - a.created)[0];
const lastCutoff = Number(last.metadata.cutoff);
const grossUpToCutoff = state.payments.filter((p) => p.created <= lastCutoff).reduce((s, p) => s + p.amount, 0);
// Arrondi : le calcul est fait mois par mois (floor), tolérance de quelques centimes
assert.ok(Math.abs(urssafTotal - Math.floor(grossUpToCutoff * 0.3)) <= runs, `URSSAF total ${urssafTotal} vs 30% de ${grossUpToCutoff}`);
console.log(`\n✓ URSSAF total = 30 % du brut encaissé (${eur(urssafTotal)} sur ${eur(grossUpToCutoff)})`);
assert.equal(detteTotal, 100000, "la dette doit être versée une seule fois, 1000 €");
console.log(`✓ dette versée une seule fois : ${eur(detteTotal)}`);
const afterDebt = [...state.payouts].filter((p) => p.created > dettePayoutsTime());
function dettePayoutsTime() { return state.payouts.find((p) => p.metadata.kind === "dette").created; }
assert.ok(afterDebt.every((p) => p.metadata.debt_reserve === "0"), "la réserve doit rester à 0 après remboursement");
console.log("✓ après remboursement de la dette, plus aucune réserve prélevée");
const dettePayouts = state.payouts.filter((p) => p.metadata.kind === "dette");
assert.equal(dettePayouts.length, 1);
assert.ok(state.payouts.every((p) => p.statement_descriptor.length <= 22));
console.log("✓ aucun libellé > 22 caractères, caractères valides");
const months = state.payouts.map((p) => `${p.metadata.month}/${p.metadata.kind}`);
assert.equal(new Set(months).size, months.length, "doublon de virement");
console.log("✓ aucun doublon de virement dans un même mois");
assert.ok(available() >= 0);
console.log(`✓ solde Stripe jamais négatif (reste ${eur(available())}, dont paiements encore en attente)`);
console.log(`\nTotaux : URSSAF ${eur(urssafTotal)} | DETTE ${eur(detteTotal)} | NET ${eur(netTotal)}`);
console.log("Exemples de libellés :", [...new Set(state.payouts.slice(0, 3).map((p) => p.statement_descriptor))].join(" / "), "/", dettePayouts[0].statement_descriptor);

// ---------- Test 3 : état partiel ----------
state.payouts.push({ id: "po_x", seq: 999, amount: 1, status: "pending", created: nowS() + 10, metadata: { month: "2028-06", kind: "urssaf", cutoff: String(nowS()), debt_reserve: "0", count: "2" } });
fakeNow = Date.UTC(2028, 5, 28, 7);
state.payouts[state.payouts.length - 1].created = Math.floor(fakeNow / 1000);
const partial = await call();
assert.equal(partial.status, 409);
console.log("✓ virement incomplet dans un mois : le script s'arrête et alerte (409)");
console.log("\nTOUS LES TESTS PASSENT");
