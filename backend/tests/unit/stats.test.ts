import { describe, expect, it } from 'vitest';
import { mannWhitney, seededRandom, shuffle, summarize } from '../../src/ops/stats.ts';

describe('estadística de la prueba de tiempos', () => {
  it('el PRNG y el barajado son reproducibles con la misma semilla', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    const items = Array.from({ length: 20 }, (_, i) => i);
    expect(shuffle(items, 7)).toEqual(shuffle(items, 7));
    expect(shuffle(items, 7)).not.toEqual(shuffle(items, 8));
    expect([...shuffle(items, 7)].sort((x, y) => x - y)).toEqual(items);
  });

  it('Mann-Whitney no distingue muestras de la misma distribución', () => {
    const r = seededRandom(1);
    const a = Array.from({ length: 40 }, () => 1000 + r() * 50);
    const b = Array.from({ length: 40 }, () => 1000 + r() * 50);
    expect(mannWhitney(a, b).p).toBeGreaterThan(0.05);
  });

  it('Mann-Whitney detecta una diferencia sistemática de 20 ms', () => {
    const r = seededRandom(2);
    const a = Array.from({ length: 40 }, () => 1000 + r() * 50);
    const b = Array.from({ length: 40 }, () => 1020 + r() * 50);
    expect(mannWhitney(a, b).p).toBeLessThan(0.001);
  });

  it('valor conocido: U y p con empates', () => {
    const { u, p } = mannWhitney([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]);
    expect(u).toBe(0);
    expect(p).toBeCloseTo(0.0122, 3);
    expect(mannWhitney([5, 5, 5], [5, 5, 5]).p).toBe(1);
  });

  it('resume mínimo, mediana, p95 y máximo', () => {
    expect(summarize([3, 1, 2, 4])).toEqual({ n: 4, min: 1, median: 3, p95: 4, max: 4, mean: 2.5 });
  });
});
