/* eslint-disable security/detect-non-literal-fs-filename -- claves validadas con DOCUMENT_KEY_RE */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { hmac, safeEqual } from '../security/crypto.ts';

/** Solo se aceptan claves con la forma de `documentKey()`; evita rutas arbitrarias. */
export const DOCUMENT_KEY_RE =
  /^results\/pat_[A-Za-z0-9_-]{22}\/res_[A-Za-z0-9_-]{22}\/v\d{1,6}\.pdf$/;

export interface DocumentStorage {
  put(key: string, body: Uint8Array): Promise<void>;
  /** URL de lectura que expira sola a los `ttlSeconds`. */
  readUrl(key: string, ttlSeconds: number): Promise<string>;
}

const assertKey = (key: string) => {
  if (!DOCUMENT_KEY_RE.test(key)) throw new Error('Clave de documento no válida');
};

/** S3 privado con SSE-KMS (la llave la impone el bucket). URL firmada SigV4. */
export class S3DocumentStorage implements DocumentStorage {
  private readonly s3: S3Client;
  private readonly bucket: string;
  constructor(s3: S3Client, bucket: string) {
    this.s3 = s3;
    this.bucket = bucket;
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    assertKey(key);
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/pdf',
      }),
    );
  }

  async readUrl(key: string, ttlSeconds: number): Promise<string> {
    assertKey(key);
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentType: 'application/pdf',
        ResponseContentDisposition: 'inline',
        ResponseCacheControl: 'no-store',
      }),
      { expiresIn: ttlSeconds },
    );
  }
}

/**
 * Solo local: imita una URL firmada de S3 (clave + expiración + HMAC) servida por el servidor
 * local. Nunca se usa en Lambda.
 */
export class LocalDocumentStorage implements DocumentStorage {
  private readonly dir: string;
  private readonly baseUrl: string;
  private readonly secret: string;
  private readonly clock: () => Date;
  constructor(options: { dir: string; baseUrl: string; secret: string; clock?: () => Date }) {
    this.dir = options.dir;
    this.baseUrl = options.baseUrl;
    this.secret = options.secret;
    this.clock = options.clock ?? (() => new Date());
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    assertKey(key);
    const path = join(this.dir, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async readUrl(key: string, ttlSeconds: number): Promise<string> {
    assertKey(key);
    const exp = Math.floor(this.clock().getTime() / 1000) + ttlSeconds;
    const params = new URLSearchParams({ key, exp: String(exp), sig: this.sign(key, exp) });
    return `${this.baseUrl}/local-documents?${params.toString()}`;
  }

  /** Devuelve el PDF si la firma es válida y no ha expirado. */
  async open(params: URLSearchParams): Promise<Uint8Array | undefined> {
    const key = params.get('key') ?? '';
    const exp = Number(params.get('exp'));
    const sig = params.get('sig') ?? '';
    if (!DOCUMENT_KEY_RE.test(key) || !Number.isInteger(exp)) return undefined;
    if (!safeEqual(sig, this.sign(key, exp))) return undefined;
    if (exp <= Math.floor(this.clock().getTime() / 1000)) return undefined;
    return readFile(join(this.dir, key)).catch(() => undefined);
  }

  private sign(key: string, exp: number): string {
    return hmac(this.secret, `local-document:${key}:${exp}`);
  }
}
