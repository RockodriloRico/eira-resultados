import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  localClient,
  localTableDefinitions,
} from '../../../infrastructure/scripts/local-tables.ts';
import { startDevServer } from '../../src/local/devServer.ts';
import { seedSyntheticViaApi } from '../../src/ops/seedDemo.ts';
import { runSmoke } from '../../src/ops/smoke.ts';
import { runTimingStudy } from '../../src/ops/timingStudy.ts';

/**
 * Prueba estadística reproducible de tiempos (ADR-0014): servidor local con el piso real de
 * 1000 ms + jitter, semilla fija y tres clases de identidad. Más smoke tests y seed vía API.
 */
const N = 30;
const letters = (i: number) =>
  `${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`;
const SEED = 20261122;
const stages: string[] = [];
const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];

async function server(minResponseMs: number, seed: boolean) {
  const stage = `ops${Date.now()}${stages.length}`;
  stages.push(stage);
  const dir = await mkdtemp(join(tmpdir(), 'eira-ops-'));
  dirs.push(dir);
  const started = await startDevServer({ port: 0, stage, dataDir: dir, minResponseMs, seed });
  closers.push(started.close);
  return started;
}

beforeAll(() => undefined);
afterAll(async () => {
  for (const close of closers) await close();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  const raw = localClient();
  for (const stage of stages)
    for (const { input } of localTableDefinitions(stage))
      await raw.send(new DeleteTableCommand({ TableName: input.TableName })).catch(() => undefined);
});

describe('prueba estadística de tiempos anti-enumeración', () => {
  let report: Awaited<ReturnType<typeof runTimingStudy>>;

  beforeAll(async () => {
    const { url, container } = await server(1000, false);
    const patients = Array.from({ length: 2 * N }, (_, i) => ({
      fullName: `Paciente Sintética ${letters(i)}`,
      birthDate: '1980-01-15',
      folio: `SINT-T${String(i).padStart(4, '0')}`,
      phone: `+5255000010${String(i).padStart(2, '0')}`,
    }));
    for (const p of patients) await container.patients.create(p, { adminId: 'prueba-tiempos' });
    report = await runTimingStudy({
      apiUrl: url,
      seed: SEED,
      concurrency: 15,
      classes: [
        { name: 'existente', bodies: patients.slice(0, N) },
        {
          name: 'no-coincidente',
          bodies: patients.slice(N).map((p) => ({ ...p, birthDate: '1981-02-16' })),
        },
        {
          name: 'inexistente',
          bodies: Array.from({ length: N }, (_, i) => ({
            fullName: 'Persona Inexistente',
            birthDate: '1980-01-15',
            folio: `SINT-X${String(i).padStart(4, '0')}`,
          })),
        },
      ].map((c) => ({
        name: c.name,
        bodies: c.bodies.map(({ fullName, birthDate, folio }) => ({ fullName, birthDate, folio })),
      })),
    });
    const out = process.env.EIRA_TIMING_REPORT;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- ruta indicada por el operador
    if (out) await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  }, 120_000);

  it('ninguna respuesta sale antes de 1000 ms y el p95 queda bajo piso + jitter + margen', () => {
    for (const [name, c] of Object.entries(report.classes)) {
      expect(c.n, name).toBe(N);
      expect(c.min, name).toBeGreaterThanOrEqual(1000);
      expect(c.p95, name).toBeLessThanOrEqual(1300);
    }
  });

  it('las tres clases responden 202 con el mismo esquema', () => {
    for (const c of Object.values(report.classes)) expect(c.statuses).toEqual([202]);
    expect(new Set(Object.values(report.classes).flatMap((c) => c.bodyShapes)).size).toBe(1);
  });

  it('las distribuciones no son distinguibles (Mann-Whitney, α = 0.001)', () => {
    expect(report.comparisons).toHaveLength(3);
    expect(report.failures).toEqual([]);
  });
});

describe('smoke tests y seed sintético contra el servidor local', () => {
  it('el seed vía API administrativa crea solo datos sintéticos y es idempotente', async () => {
    const { url } = await server(0, false);
    const first = await seedSyntheticViaApi({ apiUrl: url, stage: 'local' });
    expect(first.created).toBe(6);
    const again = await seedSyntheticViaApi({ apiUrl: url, stage: 'local' });
    expect(again.created).toBe(0);
    await expect(seedSyntheticViaApi({ apiUrl: url, stage: 'prod' })).rejects.toThrow('prod');
    await expect(seedSyntheticViaApi({ apiUrl: url, stage: 'demo' })).rejects.toThrow('token');
  });

  it('los smoke tests de la API pasan con el piso real', async () => {
    const { url } = await server(1000, true);
    const checks = await runSmoke({ apiUrl: url, stage: 'local' });
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks).toHaveLength(3);
  }, 30_000);
});
