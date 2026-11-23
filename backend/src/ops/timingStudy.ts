import { mannWhitney, shiftConfidenceInterval, shuffle, summarize, type Summary } from './stats.ts';

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
  /** Mann-Whitney: una p menor indica distribuciones distinguibles. p ≥ α no prueba equivalencia. */
  alpha: number;
  /**
   * Margen de equivalencia: el intervalo de confianza del 90 % del desplazamiento entre dos clases
   * (Hodges-Lehmann, equivalente a TOST con α = 0.05 por lado) debe quedar dentro de ±margen.
   */
  equivalenceMarginMs: number;
};

export const DEFAULT_CRITERIA: TimingCriteria = {
  floorMs: 1000,
  jitterMs: 50,
  toleranceMs: 250,
  alpha: 0.001,
  equivalenceMarginMs: 25,
};

export type TimingReport = {
  seed: number;
  criteria: TimingCriteria;
  /** `aboveMask`: respuestas por encima de piso + jitter, en las que el trabajo real no quedó oculto. */
  classes: Record<
    string,
    Summary & { statuses: number[]; bodyShapes: string[]; aboveMask: number }
  >;
  comparisons: {
    a: string;
    b: string;
    u: number;
    p: number;
    medianDiffMs: number;
    /** Desplazamiento a − b (Hodges-Lehmann) e intervalo de confianza del 90 %, en ms. */
    shiftMs: number;
    shiftCi90Ms: [number, number];
  }[];
  failures: string[];
};

export async function runTimingStudy(options: {
  apiUrl: string;
  classes: readonly TimingClass[];
  seed: number;
  concurrency: number;
  /** Separación mínima entre inicios de solicitudes, para no superar el límite por IP del WAF. */
  intervalMs?: number;
  criteria?: TimingCriteria;
  /** Solicitudes previas que se descartan (arranque en frío de JIT, conexiones y base de datos). */
  warmup?: readonly object[];
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
  let nextStart = performance.now();
  const pace = async () => {
    if (!options.intervalMs) return;
    const at = Math.max(nextStart, performance.now());
    nextStart = at + options.intervalMs;
    // setTimeout puede despertar ~1 ms antes: se repite hasta alcanzar el inicio previsto.
    for (let wait = at - performance.now(); wait > 0; wait = at - performance.now())
      await new Promise((r) => setTimeout(r, Math.ceil(wait)));
  };
  const send = (body: object) =>
    doFetch(`${options.apiUrl}/v1/access/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  for (const body of options.warmup ?? []) {
    await pace();
    await (await send(body)).arrayBuffer().catch(() => undefined);
  }
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs.at(next++)!;
      await pace();
      const started = performance.now();
      const res = await send(job.body);
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
  const byName = new Map<
    string,
    Summary & { statuses: number[]; bodyShapes: string[]; aboveMask: number }
  >();
  const ceiling = criteria.floorMs + criteria.jitterMs + criteria.toleranceMs;
  for (const [name, list] of samples) {
    const summary = summarize(list.map((s) => s.ms));
    const statuses = [...new Set(list.map((s) => s.status))];
    const bodyShapes = [...new Set(list.map((s) => s.shape))];
    const aboveMask = list.filter((s) => s.ms > criteria.floorMs + criteria.jitterMs).length;
    byName.set(name, { ...summary, statuses, bodyShapes, aboveMask });
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
      const xs = samples.get(a)!.map((s) => s.ms);
      const ys = samples.get(b)!.map((s) => s.ms);
      const { u, p } = mannWhitney(xs, ys);
      const ci = shiftConfidenceInterval(xs, ys, 0.9);
      const r1 = (x: number) => Math.round(x * 10) / 10;
      const medianDiffMs = r1(Math.abs(byName.get(a)!.median - byName.get(b)!.median));
      comparisons.push({
        a,
        b,
        u,
        p: Math.round(p * 1e4) / 1e4,
        medianDiffMs,
        shiftMs: r1(ci.shift),
        shiftCi90Ms: [r1(ci.low), r1(ci.high)],
      });
      if (p < criteria.alpha)
        failures.push(`${a} vs ${b}: distribuciones distinguibles (p=${p.toFixed(5)})`);
      const margin = criteria.equivalenceMarginMs;
      if (ci.low <= -margin || ci.high >= margin)
        failures.push(
          `${a} vs ${b}: no se demuestra equivalencia (IC 90 % [${r1(ci.low)}, ${r1(ci.high)}] ms fuera de ±${margin} ms)`,
        );
    }
  return { seed, criteria, classes: Object.fromEntries(byName), comparisons, failures };
}
