import { runtimeConfig } from '../config/runtime.ts';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const FALLBACK = 'No se pudo completar la solicitud. Intenta de nuevo.';

/**
 * Cliente mínimo de la API. `path` es relativo a `apiBaseUrl` de config.json (vacío en local, donde
 * Vite hace de proxy). El token de sesión vive solo en memoria (nunca en localStorage).
 */
export async function api<T>(
  method: 'GET' | 'POST',
  path: string,
  options: { body?: unknown; token?: string | undefined } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const res = await fetch(`${runtimeConfig().apiBaseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? null : JSON.stringify(options.body),
    credentials: 'omit',
    cache: 'no-store',
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const message = (data as { message?: unknown } | undefined)?.message;
    throw new ApiError(res.status, typeof message === 'string' ? message : FALLBACK);
  }
  return data as T;
}

export const errorMessage = (error: unknown) =>
  error instanceof ApiError ? error.message : FALLBACK;

/** SHA-256 en base64, el formato de x-amz-checksum-sha256. */
export async function sha256Base64(data: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
}
