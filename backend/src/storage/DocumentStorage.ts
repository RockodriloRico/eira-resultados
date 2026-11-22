/* eslint-disable security/detect-non-literal-fs-filename -- claves validadas con DOCUMENT_KEY_RE */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { hmac, safeEqual } from '../security/crypto.ts';

/** Solo se aceptan claves con la forma de `documentKey()`; evita rutas arbitrarias. */
export const DOCUMENT_KEY_RE =
  /^results\/pat_[A-Za-z0-9_-]{22}\/res_[A-Za-z0-9_-]{22}\/v\d{1,6}\.pdf$/;

export type UploadSpec = { sha256: string; sizeBytes: number };
export type SignedUpload = { url: string; headers: Record<string, string> };

export interface DocumentStorage {
  put(key: string, body: Uint8Array): Promise<void>;
  /** URL de lectura que expira sola a los `ttlSeconds`. */
  readUrl(key: string, ttlSeconds: number): Promise<string>;
  /** URL de carga PUT que solo acepta un archivo con ese tamaño y SHA-256 (base64). */
  uploadUrl(key: string, spec: UploadSpec, ttlSeconds: number): Promise<SignedUpload>;
  /** Tamaño y SHA-256 del objeto almacenado, sin leer su contenido; `undefined` si no existe. */
  head(key: string): Promise<UploadSpec | undefined>;
}

export const sha256Base64 = (body: Uint8Array) =>
  createHash('sha256').update(body).digest('base64');

const assertKey = (key: string) => {
  if (!DOCUMENT_KEY_RE.test(key)) throw new Error('Clave de documento no válida');
};

/** S3 privado con SSE-KMS (la llave la impone el bucket). URL firmada SigV4. */
export class S3DocumentStorage implements DocumentStorage {
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly kmsKeyArn: string | undefined;
  constructor(s3: S3Client, bucket: string, kmsKeyArn?: string) {
    this.s3 = s3;
    this.bucket = bucket;
    this.kmsKeyArn = kmsKeyArn;
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    assertKey(key);
    // La política del bucket rechaza PutObject sin SSE-KMS explícito con DocumentsKey.
    if (!this.kmsKeyArn) throw new Error('DOCUMENTS_KEY_ARN no configurado');
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/pdf',
        Metadata: { sha256: sha256Base64(body) },
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: this.kmsKeyArn,
        IfNoneMatch: '*',
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

  async uploadUrl(key: string, spec: UploadSpec, ttlSeconds: number): Promise<SignedUpload> {
    assertKey(key);
    if (!this.kmsKeyArn) throw new Error('DOCUMENTS_KEY_ARN no configurado');
    // Encabezados firmados (no en la query): S3 rechaza otro tamaño, otro SHA-256 u otro cifrado.
    // El SHA-256 se repite en metadatos porque leer el checksum de un objeto SSE-KMS exige
    // kms:Decrypt, que admin-results no tiene; los metadatos se leen con HeadObject sin descifrar.
    const headers = {
      'content-type': 'application/pdf',
      'x-amz-checksum-sha256': spec.sha256,
      'x-amz-meta-sha256': spec.sha256,
      // Escritura condicional: una URL pendiente no puede reemplazar un documento ya cargado.
      'if-none-match': '*',
      'x-amz-server-side-encryption': 'aws:kms',
      'x-amz-server-side-encryption-aws-kms-key-id': this.kmsKeyArn,
    };
    const url = await getSignedUrl(
      this.s3,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: 'application/pdf',
        ContentLength: spec.sizeBytes,
        ChecksumSHA256: spec.sha256,
        Metadata: { sha256: spec.sha256 },
        IfNoneMatch: '*',
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: this.kmsKeyArn,
      }),
      {
        expiresIn: ttlSeconds,
        unhoistableHeaders: new Set(Object.keys(headers)),
        signableHeaders: new Set(['content-type', 'content-length']),
      },
    );
    return { url, headers };
  }

  async head(key: string): Promise<UploadSpec | undefined> {
    assertKey(key);
    try {
      const out = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      const sha256 = out.Metadata?.sha256;
      if (out.ContentLength === undefined || !sha256) return undefined;
      return { sizeBytes: out.ContentLength, sha256 };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode;
      if (status === 404) return undefined;
      throw error;
    }
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

  async uploadUrl(key: string, spec: UploadSpec, ttlSeconds: number): Promise<SignedUpload> {
    assertKey(key);
    const exp = Math.floor(this.clock().getTime() / 1000) + ttlSeconds;
    const sig = this.sign(`upload:${key}:${spec.sizeBytes}:${spec.sha256}`, exp);
    const params = new URLSearchParams({
      key,
      exp: String(exp),
      size: String(spec.sizeBytes),
      sig,
    });
    return {
      url: `${this.baseUrl}/local-documents/upload?${params.toString()}`,
      headers: { 'content-type': 'application/pdf', 'x-amz-checksum-sha256': spec.sha256 },
    };
  }

  /** Imita a S3: firma vigente y el cuerpo debe tener el tamaño y SHA-256 firmados. */
  async acceptUpload(
    params: URLSearchParams,
    checksum: string | undefined,
    body: Uint8Array,
  ): Promise<boolean> {
    const key = params.get('key') ?? '';
    const exp = Number(params.get('exp'));
    const size = Number(params.get('size'));
    const sig = params.get('sig') ?? '';
    if (!DOCUMENT_KEY_RE.test(key) || !Number.isInteger(exp) || !checksum) return false;
    if (!safeEqual(sig, this.sign(`upload:${key}:${size}:${checksum}`, exp))) return false;
    if (exp <= Math.floor(this.clock().getTime() / 1000)) return false;
    if (body.byteLength !== size || sha256Base64(body) !== checksum) return false;
    if (await this.head(key)) return false; // imita If-None-Match: * de S3
    await this.put(key, body);
    return true;
  }

  async head(key: string): Promise<UploadSpec | undefined> {
    assertKey(key);
    const body = await readFile(join(this.dir, key)).catch(() => undefined);
    return body && { sizeBytes: body.byteLength, sha256: sha256Base64(body) };
  }

  private sign(key: string, exp: number): string {
    return hmac(this.secret, `local-document:${key}:${exp}`);
  }
}
