// Test unitaire : provision d'impôt cumulative sur l'année. Lancer : node test/tax.mjs
import assert from "node:assert/strict";
import { makeTaxFn } from "../lib/tax.js";
import { computeRun } from "../api/monthly-payout.js";

const taxFn = makeTaxFn({ abatement: 34, parts: 1 });

// Sous le seuil : 0 € d'impôt. 17 500 € de CA -> 11 550 € imposables < 11 600
assert.equal(taxFn(1750000), 0);
// 30 000 € de CA -> 19 800 € imposables -> (19 800 - 11 600) * 11 % = 902 €
assert.equal(taxFn(3000000), 90200);
console.log("✓ impôt estimé : 0 € sous le seuil, 902 € pour 30 000 € de CA (34 % d'abattement, 1 part)");

// Année : 12 mois à 3 000 € de CA, solde largement suffisant. Réserve cumulée = impôt sur le CA cumulé.
let ytd = 0, reserve = 0, totalPaidTax = 0, net = 0;
for (let month = 1; month <= 12; month++) {
  const C = 300000, A = 1_000_000; // 3 000 € encaissés ce mois, solde dispo ample
  const r = computeRun({ C, A, ytd, taxReserve: reserve, taxFn, taxPayoutNow: month === 12 });
  ytd = r.ytdAfter; reserve = r.taxHeld; totalPaidTax += r.impots; net += r.net;
  assert.ok(r.net >= 0 && r.urssaf === Math.floor(C * 0.3));
}
assert.equal(ytd, 3_600_000);
assert.equal(totalPaidTax, taxFn(3_600_000), "le virement de décembre = impôt estimé sur le CA annuel");
assert.equal(reserve, 0, "réserve vidée après le virement de décembre");
console.log(`✓ 12 × 3 000 € : virement impôts de décembre = ${(totalPaidTax / 100).toFixed(2)} €, réserve remise à 0`);

// Solde insuffisant : jamais plus que le disponible, rattrape le mois suivant
const r1 = computeRun({ C: 5_000_000, A: 1_800_000, ytd: 0, taxReserve: 0, taxFn });
assert.ok(r1.urssaf + r1.taxAdded <= 1_800_000);
console.log("✓ solde insuffisant : provision plafonnée au disponible");
console.log("\nTESTS IMPOT OK");
