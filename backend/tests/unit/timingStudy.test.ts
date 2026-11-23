import { describe, expect, it } from 'vitest';
import { runTimingStudy } from '../../src/ops/timingStudy.ts';

describe('runTimingStudy', () => {
  it('respeta la separación mínima entre solicitudes', async () => {
    const starts: number[] = [];
    const fetchFn = (async () => {
      starts.push(performance.now());
      return new Response(JSON.stringify({ challengeId: 'x' }), { status: 202 });
    }) as typeof fetch;
    await runTimingStudy({
      apiUrl: 'https://api.example',
      classes: [{ name: 'a', bodies: [{}, {}, {}, {}] }],
      seed: 1,
      concurrency: 2,
      intervalMs: 40,
      fetchFn,
    });
    expect(starts).toHaveLength(4);
    // Cada inicio respeta su turno (i × intervalo; 0.5 ms por el registro dentro de fetchFn).
    for (let i = 1; i < starts.length; i++)
      expect(starts.at(i)! - starts.at(0)!).toBeGreaterThanOrEqual(40 * i - 0.5);
  });

  it('descarta el calentamiento y separa piso, comparación y equivalencia', async () => {
    let calls = 0;
    const fetchFn = (async (_url: string, init: { body: string }) => {
      calls++;
      const { slow } = JSON.parse(init.body) as { slow?: number };
      await new Promise((r) => setTimeout(r, 30 + (slow ?? 0) + Math.random() * 5));
      return new Response(JSON.stringify({ challengeId: 'x' }), { status: 202 });
    }) as unknown as typeof fetch;
    const criteria = {
      floorMs: 30,
      jitterMs: 5,
      toleranceMs: 100,
      alpha: 0.001,
      equivalenceMarginMs: 3,
    };
    const same = await runTimingStudy({
      apiUrl: 'https://api.example',
      classes: [
        { name: 'a', bodies: Array.from({ length: 30 }, () => ({})) },
        { name: 'b', bodies: Array.from({ length: 30 }, () => ({})) },
      ],
      seed: 3,
      concurrency: 10,
      criteria: { ...criteria, equivalenceMarginMs: 1000 },
      warmup: [{ slow: 500 }, { slow: 500 }],
      fetchFn,
    });
    expect(calls).toBe(62);
    expect(same.classes.a!.n).toBe(30);
    expect(same.classes.a!.max).toBeLessThan(500);
    const shifted = await runTimingStudy({
      apiUrl: 'https://api.example',
      classes: [
        { name: 'a', bodies: Array.from({ length: 30 }, () => ({})) },
        { name: 'b', bodies: Array.from({ length: 30 }, () => ({ slow: 20 })) },
      ],
      seed: 3,
      concurrency: 10,
      criteria,
      fetchFn,
    });
    expect(shifted.classes.b!.aboveMask).toBe(30);
    expect(shifted.comparisons[0]!.shiftCi90Ms[1]).toBeLessThan(-3);
    expect(shifted.failures.join('\n')).toMatch(/no se demuestra equivalencia/);
    expect(shifted.failures.join('\n')).toMatch(/distinguibles/);
  });
});
