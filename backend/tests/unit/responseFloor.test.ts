import { describe, expect, it } from 'vitest';
import { withResponseFloor } from '../../src/http/responseFloor.ts';

describe('tiempo mínimo de respuesta', () => {
  it('no responde antes del piso, ni en éxito ni en error', async () => {
    let started = performance.now();
    await withResponseFloor(80, async () => 'ok');
    expect(performance.now() - started).toBeGreaterThanOrEqual(79);
    started = performance.now();
    await expect(
      withResponseFloor(80, async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    expect(performance.now() - started).toBeGreaterThanOrEqual(79);
  });

  it('con piso 0 no espera', async () => {
    const started = performance.now();
    await withResponseFloor(0, async () => 'ok');
    expect(performance.now() - started).toBeLessThan(20);
  });
});
