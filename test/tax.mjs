// Tests impôt + cas limites de computeRun. Lancer : node test/tax.mjs
import assert from "node:assert/strict";
import { makeTaxFn, householdTax } from "../lib/tax.js";
import { computeRun } from "../api/monthly-payout.js";

const e = (c) => (c / 100).toFixed(2) + " €";
const taxFn = makeTaxFn({ abatement: 34, parts: 1 });

// --- Chiffres vérifiés sur service-public.gouv.fr ---
// Exemple officiel F1419 : célibataire 30 000 € imposables -> impôt brut 1 977,69 + 126,30 = 2 103,99 € (> plafond décote : pas de décote)
assert.ok(Math.abs(householdTax(30000, 1, false) - 2103.99) < 0.01);
// Exemple officiel F34328 : célibataire, impôt brut 1 400 € -> décote 263,50 € -> 1 136,50 €. (impôt brut 1 400 € <=> revenu imposable ~ 24 000 €)
const t1400 = (1400 / 0.11) + 11600; // revenu qui donne 1 400 € de brut (tranche 11 %)
assert.ok(Math.abs(householdTax(t1400, 1, false) - 1136.5) < 0.01);
// Seuil 61 € : impôt net < 61 € non recouvré
assert.equal(householdTax(11600 + 100, 1, false), 0);
console.log("✓ barème, décote et seuil 61 € = exemples officiels service-public.gouv.fr");

assert.equal(taxFn(1750000), 0); // 17 500 € de CA -> 11 550 € imposables : 0 €
assert.equal(taxFn(0), 0);
console.log(`✓ CA 30 000 € (BNC, 1 part) -> impôt estimé ${e(taxFn(3000000))} ; CA 36 000 € -> ${e(taxFn(3600000))}`);

// --- Année complète : réserve cumulée = impôt sur le CA cumulé ---
{
  let ytd = 0, reserve = 0, paid = 0;
  for (let month = 1; month <= 12; month++) {
    const r = computeRun({ C: 300000, A: 1_000_000, ytd, taxReserve: reserve, taxFn, taxPayoutNow: month === 12 });
    ytd = r.ytdAfter; reserve = r.taxHeld; paid += r.impots;
  }
  assert.equal(paid, taxFn(3_600_000));
  assert.equal(reserve, 0);
  console.log(`✓ 12 × 3 000 € : virement impôts de décembre = ${e(paid)}`);
}

// --- Cas limites ---
// Mois sans paiement : rien à virer sauf le net éventuel
{
  const r = computeRun({ C: 0, A: 0, taxFn });
  assert.deepEqual([r.urssaf, r.dette, r.impots, r.net], [0, 0, 0, 0]);
  console.log("✓ mois sans paiement : aucun virement");
}
// Remboursement supérieur au CA de la période (C négatif) : rien de négatif
{
  const r = computeRun({ C: -20000, A: 50000, ytd: 1_000_000, taxReserve: 0, taxFn, target: 100000 });
  assert.ok(r.urssaf === 0 && r.dette === 0 && r.net >= 0 && r.ytdAfter === 980000);
  console.log("✓ remboursement > CA de la période : pas de virement négatif");
}
// Solde disponible insuffisant : priorité URSSAF, puis dette, puis impôt, jamais au-dessus du solde
{
  const r = computeRun({ C: 1_000_000, A: 250000, ytd: 2_500_000, taxFn, target: 100000 });
  assert.ok(r.urssaf + r.dette + r.impots + r.net <= 250000);
  assert.equal(r.urssaf, 250000); // 30 % de 10 000 € = 3 000 € > 2 500 € disponibles : tout va à l'URSSAF
  console.log("✓ solde insuffisant : tout le disponible va d'abord à l'URSSAF");
}
// Décembre, dette atteinte et impôt dû la même fois : trois virements + net, total <= solde
{
  const A = 2_000_000;
  const r = computeRun({ C: 500000, A, reservePrev: 95000, target: 100000, ytd: 4_000_000, taxReserve: taxFn(4_000_000), taxFn, taxPayoutNow: true });
  assert.ok(r.urssaf > 0 && r.dette > 0 && r.impots > 0);
  assert.ok(r.urssaf + r.dette + r.impots + r.net <= A);
  console.log(`✓ décembre complet : URSSAF ${e(r.urssaf)} | DETTE ${e(r.dette)} | IMPOTS ${e(r.impots)} | NET ${e(r.net)}`);
}
// Démarrage en cours d'année avec CA déjà encaissé : la provision rattrape l'impôt du cumul
{
  const r = computeRun({ C: 200000, A: 5_000_000, ytd: 4_000_000, taxReserve: 0, taxFn });
  assert.equal(r.taxAdded, taxFn(4_200_000));
  console.log(`✓ démarrage en cours d'année (YTD 40 000 €) : rattrapage de ${e(r.taxAdded)} d'impôt d'un coup`);
}

// --- Test aléatoire : 50 000 cas, invariants ---
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
for (let i = 0; i < 50000; i++) {
  const C = Math.round((rnd() * 4_000_000) - 200_000);
  const A = Math.round(rnd() * 5_000_000);
  const ytd = Math.round(rnd() * 12_000_000);
  const reservePrev = Math.round(rnd() * 120_000);
  const taxReserve = Math.round(rnd() * 500_000);
  const fn = makeTaxFn({ abatement: rnd() < 0.5 ? 34 : 50, parts: 1 + Math.floor(rnd() * 3) * 0.5, couple: rnd() < 0.5, otherIncomeCents: Math.round(rnd() * 3_000_000) });
  const r = computeRun({ C, A, reservePrev, debtDone: rnd() < 0.2, target: 100000, ytd, taxReserve, taxFn: fn, taxPayoutNow: rnd() < 0.1 });
  const total = r.urssaf + r.dette + r.impots + r.net;
  assert.ok([r.urssaf, r.dette, r.impots, r.net, r.heldAfter, r.taxHeld].every((x) => Number.isInteger(x) && x >= 0), JSON.stringify({ C, A, r }));
  assert.ok(total <= A, `virements ${total} > solde ${A}`);
  assert.ok(r.urssaf <= Math.max(0, Math.floor(C * 0.3)) + 0);
}
console.log("✓ 50 000 cas aléatoires : jamais négatif, jamais plus que le solde, URSSAF <= 30 % du CA");
console.log("\nTESTS IMPOT / CAS LIMITES OK");
