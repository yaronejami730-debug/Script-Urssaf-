// Estimation de l'impôt sur le revenu d'un micro-entrepreneur (régime micro, sans versement libératoire).
// Barème progressif par tranche, quotient familial. Estimation prudente : décote et plafonnement du
// quotient familial ignorés. Barème à mettre à jour chaque année (variable TAX_BRACKETS_JSON).

// Barème (revenus 2025, déclarés en 2026) : [plafond de tranche en €, taux]
export const DEFAULT_BRACKETS = [
  [11600, 0],
  [29579, 0.11],
  [84577, 0.3],
  [181917, 0.41],
  [Infinity, 0.45],
];

export function bracketTax(incomePerPart, brackets = DEFAULT_BRACKETS) {
  let tax = 0, prev = 0;
  for (const [cap, rate] of brackets) {
    if (incomePerPart > prev) tax += (Math.min(incomePerPart, cap) - prev) * rate;
    prev = cap;
  }
  return tax;
}

/**
 * Fabrique une fonction ca_brut_cumulé_en_centimes -> impôt_estimé_en_centimes.
 *  abatement : % d'abattement forfaitaire (34 BNC, 50 BIC services, 71 vente)
 *  parts : nombre de parts du foyer fiscal
 *  otherIncomeCents : autres revenus imposables du foyer (salaires nets imposables...), en centimes
 */
export function makeTaxFn({ abatement = 34, parts = 1, otherIncomeCents = 0, brackets = DEFAULT_BRACKETS } = {}) {
  return (grossCents) => {
    const taxable = (grossCents * (1 - abatement / 100) + otherIncomeCents) / 100; // en €
    const withBusiness = parts * bracketTax(taxable / parts, brackets);
    const withoutBusiness = parts * bracketTax(otherIncomeCents / 100 / parts, brackets);
    return Math.max(0, Math.round((withBusiness - withoutBusiness) * 100)); // impôt dû à cause de l'activité
  };
}
