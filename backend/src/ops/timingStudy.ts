import { mannWhitney, shuffle, summarize, type Summary } from './stats.ts';

/**
 * Prueba estadística reproducible de tiempos de `POST /v1/access/request` (ADR-0014).
 * El orden de las solicitudes sale de una semilla fija; los umbrales son fijos.
 */
export type TimingClass = { name: string; bodies: readonly object[] };

export type TimingCriteria = {
  floorMs: number;
  jitterMs: number;
  /** Margen para la latencia de red y del cliente por encima de piso + jitter. */
  toleranceMs: number;
  /** Nivel de significancia: una p menor indica distribuciones distinguibles. */
  alpha: number;
  /** Diferencia máxima entre medianas de dos clases. */
  maxMedianDiffMs: number;
};

export const DEFAULT_CRITERIA: TimingCriteria = {
  floorMs: 1000,
  jitterMs: 50,
  toleranceMs: 250,
  alpha: 0.001,
  maxMedianDiffMs: 25,
};

export type TimingReport = {
  seed: number;
  criteria: TimingCriteria;
  classes: Record<string, Summary & { statuses: number[]; bodyShapes: string[] }>;
  comparisons: { a: string; b: string; u: number; p: number; medianDiffMs: number }[];
  failures: string[];
};

export async function runTimingStudy(options: {
  apiUrl: string;
  classes: readonly TimingClass[];
  seed: number;
  concurrency: number;
  criteria?: TimingCriteria;
  fetchFn?: typeof fetch;
}): Promise<TimingReport> {
  const criteria = options.criteria ?? DEFAULT_CRITERIA;
  const doFetch = options.fetchFn ?? fetch;
  const jobs = shuffle(
    options.classes.flatMap((c) => c.bodies.map((body) => ({ name: c.name, body }))),
    options.seed,
  );
  const samples = new Map<string, { ms: number; status: number; shape: string }[]>(
    options.classes.map((c) => [c.name, []]),
  );
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs.at(next++)!;
      const started = performance.now();
      const res = await doFetch(`${options.apiUrl}/v1/access/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(job.body),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      samples.get(job.name)!.push({
        ms: performance.now() - started,
        status: res.status,
        shape: Object.keys(body).sort().join(','),
      });
    }
  };
  await Promise.all(Array.from({ length: options.concurrency }, worker));
  return evaluate(options.seed, criteria, samples);
}

function evaluate(
  seed: number,
  criteria: TimingCriteria,
  samples: Map<string, { ms: number; status: number; shape: string }[]>,
): TimingReport {
  const failures: string[] = [];
  const byName = new Map<string, Summary & { statuses: number[]; bodyShapes: string[] }>();
  const ceiling = criteria.floorMs + criteria.jitterMs + criteria.toleranceMs;
  for (const [name, list] of samples) {
    const summary = summarize(list.map((s) => s.ms));
    const statuses = [...new Set(list.map((s) => s.status))];
    const bodyShapes = [...new Set(list.map((s) => s.shape))];
    byName.set(name, { ...summary, statuses, bodyShapes });
    if (summary.min < criteria.floorMs)
      failures.push(
        `${name}: respuesta en ${summary.min} ms, antes del piso de ${criteria.floorMs}`,
      );
    if (summary.p95 > ceiling)
      failures.push(`${name}: p95 de ${summary.p95} ms supera ${ceiling} ms`);
    if (statuses.length !== 1 || statuses[0] !== 202)
      failures.push(`${name}: códigos ${statuses.join(',')} (se espera solo 202)`);
  }
  const shapes = new Set([...byName.values()].flatMap((c) => c.bodyShapes));
  if (shapes.size !== 1)
    failures.push(`esquemas de respuesta distintos: ${[...shapes].join(' | ')}`);
  const names = [...samples.keys()];
  const comparisons: TimingReport['comparisons'] = [];
  for (let i = 0; i < names.length; i++)
    for (let j = i + 1; j < names.length; j++) {
      const a = names.at(i)!;
      const b = names.at(j)!;
      const { u, p } = mannWhitney(
        samples.get(a)!.map((s) => s.ms),
        samples.get(b)!.map((s) => s.ms),
      );
      const medianDiffMs =
        Math.round(Math.abs(byName.get(a)!.median - byName.get(b)!.median) * 10) / 10;
      comparisons.push({ a, b, u, p: Math.round(p * 1e4) / 1e4, medianDiffMs });
      if (p < criteria.alpha)
        failures.push(`${a} vs ${b}: distribuciones distinguibles (p=${p.toFixed(5)})`);
      if (medianDiffMs > criteria.maxMedianDiffMs)
        failures.push(`${a} vs ${b}: medianas difieren ${medianDiffMs} ms`);
    }
  return { seed, criteria, classes: Object.fromEntries(byName), comparisons, failures };
}
