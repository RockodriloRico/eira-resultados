/** Estadística mínima y determinista para la prueba de tiempos anti-enumeración (ADR-0014). */

/** PRNG mulberry32: misma semilla, misma secuencia. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], seed: number): T[] {
  const random = seededRandom(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const picked = out.at(j)!;
    out.splice(j, 1, out.at(i)!);
    out.splice(i, 1, picked);
  }
  return out;
}

export type Summary = {
  n: number;
  min: number;
  median: number;
  p95: number;
  max: number;
  mean: number;
};

const quantile = (sorted: number[], q: number) =>
  sorted.at(Math.min(sorted.length - 1, Math.floor(q * sorted.length)))!;

export function summarize(values: readonly number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b);
  const round = (x: number) => Math.round(x * 10) / 10;
  return {
    n: sorted.length,
    min: round(sorted.at(0)!),
    median: round(quantile(sorted, 0.5)),
    p95: round(quantile(sorted, 0.95)),
    max: round(sorted.at(-1)!),
    mean: round(sorted.reduce((s, x) => s + x, 0) / sorted.length),
  };
}

/** Función de distribución normal estándar (Abramowitz-Stegun 7.1.26). */
function normalCdf(z: number): number {
  const t = 1 / (1 + (0.3275911 * Math.abs(z)) / Math.SQRT2);
  const poly =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** Mann-Whitney U bilateral con aproximación normal y corrección por empates. */
export function mannWhitney(a: readonly number[], b: readonly number[]): { u: number; p: number } {
  const all = [...a.map((v) => ({ v, g: 0 })), ...b.map((v) => ({ v, g: 1 }))].sort(
    (x, y) => x.v - y.v,
  );
  const ranks = new Array<number>(all.length);
  let tie = 0;
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j + 1 < all.length && all.at(j + 1)!.v === all.at(i)!.v) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks.splice(k, 1, rank);
    const size = j - i + 1;
    tie += size ** 3 - size;
    i = j + 1;
  }
  const n1 = a.length;
  const n2 = b.length;
  const r1 = all.reduce((s, x, i) => (x.g === 0 ? s + ranks.at(i)! : s), 0);
  const u1 = r1 - (n1 * (n1 + 1)) / 2;
  const u = Math.min(u1, n1 * n2 - u1);
  const n = n1 + n2;
  const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - tie / (n * (n - 1))));
  if (sigma === 0) return { u, p: 1 };
  const z = (Math.abs(u1 - (n1 * n2) / 2) - 0.5) / sigma;
  return { u, p: Math.min(1, 2 * (1 - normalCdf(Math.max(0, z)))) };
}
