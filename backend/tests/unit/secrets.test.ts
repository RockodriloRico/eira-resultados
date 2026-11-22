import { describe, expect, it, vi } from 'vitest';
import { AwsSecretsProvider } from '../../src/security/secrets.ts';

describe('AwsSecretsProvider', () => {
  it('no deja en caché un fallo transitorio', async () => {
    const provider = new AwsSecretsProvider('arn:identity', 'arn:pin');
    const read = vi
      .spyOn(provider as unknown as { read: (arn: string) => Promise<string> }, 'read')
      .mockRejectedValueOnce(new Error('transitorio'))
      .mockResolvedValue('s'.repeat(32));
    await expect(provider.get()).rejects.toThrow('transitorio');
    await expect(provider.get()).resolves.toEqual({
      identity: 's'.repeat(32),
      pin: 's'.repeat(32),
    });
    expect(read).toHaveBeenCalledTimes(4);
  });
});
