// Estimation de l'impôt sur le revenu d'un micro-entrepreneur (régime micro, sans versement libératoire).
// Sources officielles vérifiées (service-public.gouv.fr, nov. 2026) :
//  - barème revenus 2025 (F1419) : 0 % jusqu'à 11 600 €, 11 % jusqu'à 29 579 €, 30 % jusqu'à 84 577 €, 41 % jusqu'à 181 917 €, 45 % au-delà
//  - décote (F34328) : célibataire 897 € - 45,25 % de l'impôt (si impôt brut <= 1 982 €) ; couple 1 483 € (si <= 3 277 €)
//  - impôt non recouvré s'il est inférieur à 61 €
//  - abattement micro (F23267) : 34 % BNC, 50 % BIC services, 71 % vente, minimum 305 €
// Non pris en compte : plafonnement du quotient familial (surestime pas, sous-estime légèrement avec enfants),
// réductions/crédits d'impôt, prélèvements sociaux sur autres revenus. Barème à mettre à jour chaque année.

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

// Impôt net (€) du foyer pour un revenu imposable donné : barème, quotient familial, décote, seuil de 61 €
export function householdTax(taxableEuros, parts, couple) {
  const brut = parts * bracketTax(taxableEuros / parts);
  const ceiling = couple ? 3277 : 1982;
  const base = couple ? 1483 : 897;
  const decote = brut <= ceiling ? Math.max(0, base - 0.4525 * brut) : 0;
  const net = Math.max(0, brut - decote);
  return net < 61 ? 0 : net;
}

/**
 * Fabrique une fonction ca_brut_cumulé_en_centimes -> impôt_estimé_en_centimes (dû à cause de l'activité).
 *  abatement : % d'abattement forfaitaire ; parts : parts du foyer ; couple : foyer en couple (décote différente)
 *  otherIncomeCents : autres revenus imposables du foyer sur l'année, en centimes
 */
export function makeTaxFn({ abatement = 34, parts = 1, couple = false, otherIncomeCents = 0 } = {}) {
  return (grossCents) => {
    const gross = Math.max(0, grossCents) / 100;
    // abattement minimum 305 € (jamais plus que le CA)
    const base = Math.max(gross - Math.max(gross * (abatement / 100), Math.min(gross, 305)), 0);
    const other = otherIncomeCents / 100;
    const withBiz = householdTax(base + other, parts, couple);
    const without = householdTax(other, parts, couple);
    return Math.max(0, Math.round((withBiz - without) * 100));
  };
}
