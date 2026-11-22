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
