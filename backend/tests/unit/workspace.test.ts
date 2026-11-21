import { SECURITY_POLICY } from '@eira/shared';
import { describe, expect, it } from 'vitest';
import { LAMBDA_RUNTIME } from '../../src/runtime.ts';

describe('workspace del backend', () => {
  it('consume el paquete compartido @eira/shared', () => {
    expect(SECURITY_POLICY.downloadUrlTtlSeconds).toBe(60);
  });

  it('usa el runtime de Lambda alineado con la versión de Node.js del proyecto', () => {
    const nodeMajor = process.versions.node.split('.')[0];
    expect(LAMBDA_RUNTIME).toBe(`nodejs${nodeMajor}.x`);
  });
});
