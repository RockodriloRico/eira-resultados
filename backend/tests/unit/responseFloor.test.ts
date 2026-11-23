import { afterEach, describe, expect, it, vi } from 'vitest';
import { withResponseFloor } from '../../src/http/responseFloor.ts';

afterEach(() => vi.restoreAllMocks());

describe('piso de respuesta anti-enumeración', () => {
  it('nunca responde antes del piso y el jitter queda en 0–50 ms', async () => {
    const times = await Promise.all(
      Array.from({ length: 30 }, async () => {
        const started = performance.now();
        await withResponseFloor(200, async () => undefined);
        return performance.now() - started;
      }),
    );
    expect(Math.min(...times)).toBeGreaterThanOrEqual(199);
    expect(Math.max(...times)).toBeLessThan(200 + 50 + 60);
    expect(new Set(times.map((t) => Math.floor(t / 10))).size).toBeGreaterThan(1);
  });

  it('si el trabajo supera el piso emite ResponseFloorExceeded y no añade espera', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const started = performance.now();
    await withResponseFloor(20, () => new Promise((r) => setTimeout(r, 120)));
    expect(performance.now() - started).toBeLessThan(200);
    expect(write.mock.calls.map(([line]) => String(line)).join('')).toContain(
      'ResponseFloorExceeded',
    );
  });

  it('propaga errores sin adelantar la respuesta', async () => {
    const started = performance.now();
    await expect(withResponseFloor(150, () => Promise.reject(new Error('fallo')))).rejects.toThrow(
      'fallo',
    );
    expect(performance.now() - started).toBeGreaterThanOrEqual(149);
  });

  it('con piso 0 no espera', async () => {
    const started = performance.now();
    await withResponseFloor(0, async () => 'ok');
    expect(performance.now() - started).toBeLessThan(20);
  });
});
