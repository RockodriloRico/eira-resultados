import { afterEach, describe, expect, it, vi } from 'vitest';
import { METRIC_NAMES, METRIC_NAMESPACE, logger } from '../../src/observability/logger.ts';

afterEach(() => vi.restoreAllMocks());

describe('métricas de aplicación (EMF)', () => {
  it('emite solo el nombre, el conteo y la dimensión Stage', () => {
    const lines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    vi.stubEnv('STAGE', 'demo');
    for (const name of METRIC_NAMES) logger.metric(name);
    vi.unstubAllEnvs();
    expect(lines).toHaveLength(METRIC_NAMES.length);
    for (const [line, name] of lines.map((l, i) => [l, METRIC_NAMES.at(i)!] as const)) {
      const emf = new Map(
        Object.entries(
          JSON.parse(line) as Record<string, { CloudWatchMetrics?: unknown } | string | number>,
        ),
      );
      expect([...emf.keys()].sort()).toEqual(['Stage', '_aws', name].sort());
      expect(emf.get('Stage')).toBe('demo');
      expect(emf.get(name)).toBe(1);
      expect((emf.get('_aws') as { CloudWatchMetrics: unknown }).CloudWatchMetrics).toEqual([
        {
          Namespace: METRIC_NAMESPACE,
          Dimensions: [['Stage']],
          Metrics: [{ Name: name, Unit: 'Count' }],
        },
      ]);
    }
  });
});
