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
    for (let i = 1; i < starts.length; i++)
      expect(starts.at(i)! - starts.at(i - 1)!).toBeGreaterThanOrEqual(38);
  });
});
