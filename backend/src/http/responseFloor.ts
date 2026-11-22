import { randomInt } from 'node:crypto';
import { logger } from '../observability/logger.ts';

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Anti-enumeración por tiempos: la respuesta nunca sale antes de `minMs` + jitter (0–50 ms).
 * Si el trabajo supera el piso se emite `ResponseFloorExceeded` para ajustarlo.
 */
export async function withResponseFloor<T>(minMs: number, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const target = minMs > 0 ? minMs + randomInt(0, 51) : 0;
  try {
    return await work();
  } finally {
    const elapsed = performance.now() - started;
    if (elapsed > target && minMs > 0) logger.metric('ResponseFloorExceeded');
    if (target > elapsed) await sleep(target - elapsed);
  }
}
