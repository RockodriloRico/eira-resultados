import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { S3DocumentStorage } from '../../src/storage/DocumentStorage.ts';

const key = `results/pat_${'a'.repeat(22)}/res_${'b'.repeat(22)}/v1.pdf`;
const keyArn = 'arn:aws:kms:us-east-1:000000000000:key/00000000-0000-0000-0000-000000000000';

describe('S3DocumentStorage.put', () => {
  it('envía SSE-KMS explícito con la llave de documentos', async () => {
    const sent: unknown[] = [];
    const s3 = { send: (c: unknown) => (sent.push(c), Promise.resolve({})) } as unknown as S3Client;
    await new S3DocumentStorage(s3, 'bucket', keyArn).put(key, new Uint8Array([1]));
    const cmd = sent[0] as PutObjectCommand;
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(cmd.input).toMatchObject({ ServerSideEncryption: 'aws:kms', SSEKMSKeyId: keyArn });
  });

  it('sin llave configurada no intenta subir', async () => {
    const s3 = {
      send: () => Promise.reject(new Error('no debería llamarse')),
    } as unknown as S3Client;
    await expect(new S3DocumentStorage(s3, 'bucket').put(key, new Uint8Array([1]))).rejects.toThrow(
      'DOCUMENTS_KEY_ARN',
    );
  });
});

describe('S3DocumentStorage.uploadUrl', () => {
  it('firma tamaño, SHA-256 y SSE-KMS como encabezados obligatorios', async () => {
    const { S3Client } = await import('@aws-sdk/client-s3');
    const s3 = new S3Client({
      region: 'us-east-1',
      credentials: { accessKeyId: 'AKIDSINTETICO', secretAccessKey: 'sintetico' },
    });
    const sha256 = 'A'.repeat(43) + '=';
    const { url, headers } = await new S3DocumentStorage(s3, 'bucket', keyArn).uploadUrl(
      key,
      { sha256, sizeBytes: 1234 },
      300,
    );
    const q = new URL(url).searchParams;
    expect(q.get('X-Amz-Expires')).toBe('300');
    const signed = q.get('X-Amz-SignedHeaders')!.split(';');
    expect(signed).toEqual(
      expect.arrayContaining([
        'content-length',
        'content-type',
        'x-amz-checksum-sha256',
        'x-amz-server-side-encryption',
        'x-amz-server-side-encryption-aws-kms-key-id',
      ]),
    );
    expect(headers['x-amz-checksum-sha256']).toBe(sha256);
    expect(headers['x-amz-server-side-encryption-aws-kms-key-id']).toBe(keyArn);
  });
});
