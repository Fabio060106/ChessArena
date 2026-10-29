/**
 * Statistiques pour la validation du taux de faux positifs.
 *
 * Avec x déclenchements sur n essais indépendants, le taux observé x/n ne suffit pas :
 * 0 sur 500 ne prouve PAS un taux < 0,1 %. On rapporte la borne supérieure exacte de
 * Clopper-Pearson (unilatérale, 95 %) : le seuil n'est validé que si ELLE est < 0,1 %.
 * Repère : avec 0 déclenchement, il faut n ≥ 2 995 essais (« règle de trois »).
 */
function logBinomCoef(n: number, k: number): number {
  return lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);
}

/** ln Γ(x), approximation de Lanczos (précision ~1e-13). */
export function lgamma(x: number): number {
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = c[0]!;
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** P(X ≤ x) pour X ~ Binomiale(n, p). */
export function binomCdf(x: number, n: number, p: number): number {
  if (p <= 0) return 1;
  if (p >= 1) return x >= n ? 1 : 0;
  let s = 0;
  for (let k = 0; k <= x; k++) s += Math.exp(logBinomCoef(n, k) + k * Math.log(p) + (n - k) * Math.log1p(-p));
  return Math.min(1, s);
}

/** Borne supérieure unilatérale de Clopper-Pearson au niveau de confiance `conf`. */
export function clopperPearsonUpper(x: number, n: number, conf = 0.95): number {
  if (n === 0) return 1;
  if (x >= n) return 1;
  const alpha = 1 - conf;
  if (x === 0) return 1 - alpha ** (1 / n);
  let lo = x / n;
  let hi = 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (binomCdf(x, n, mid) > alpha) lo = mid; else hi = mid;
  }
  return hi;
}

/** Nombre d'essais nécessaires pour qu'un résultat sans déclenchement prouve `target`. */
export function trialsNeededForZero(target: number, conf = 0.95): number {
  return Math.ceil(Math.log(1 - conf) / Math.log(1 - target));
}
