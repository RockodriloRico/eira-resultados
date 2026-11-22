import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { z } from 'zod';

export type HttpResult = APIGatewayProxyResult;

export class HttpError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export const GENERIC = {
  badRequest: 'Solicitud no válida',
  notFound: 'No encontrado',
  invalidCode: 'Código incorrecto o expirado',
  internal: 'Ocurrió un error. Intenta de nuevo más tarde.',
} as const;

export function json(statusCode: number, body: unknown, origin?: string): HttpResult {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return { statusCode, headers, body: body === undefined ? '' : JSON.stringify(body) };
}

export function parseJson<S extends z.ZodType>(schema: S, raw: string | null): z.infer<S> {
  let data: unknown;
  try {
    data = raw ? JSON.parse(raw) : undefined;
  } catch {
    throw new HttpError(400, GENERIC.badRequest);
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new HttpError(400, GENERIC.badRequest);
  return parsed.data;
}

export function parseWith<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new HttpError(400, GENERIC.badRequest);
  return parsed.data;
}

export const requestMeta = (event: APIGatewayProxyEvent) => ({
  requestId: event.requestContext?.requestId ?? 'local',
  sourceIp: event.requestContext?.identity?.sourceIp ?? undefined,
  userAgent: event.headers?.['User-Agent'] ?? event.headers?.['user-agent'] ?? undefined,
});

/** Contexto que entrega el authorizer de sesión; el patientId nunca viene del cliente. */
export function sessionContext(event: APIGatewayProxyEvent): {
  patientId: string;
  tokenHash: string;
} {
  const ctx = event.requestContext?.authorizer as Record<string, unknown> | null | undefined;
  const patientId = ctx?.patientId;
  const tokenHash = ctx?.tokenHash;
  if (typeof patientId !== 'string' || typeof tokenHash !== 'string') {
    throw new HttpError(401, 'No autorizado');
  }
  return { patientId, tokenHash };
}

/** Identidad del administrador (claims de Cognito). */
export function adminContext(event: APIGatewayProxyEvent): { adminId: string } {
  const claims = (event.requestContext?.authorizer as Record<string, unknown> | null | undefined)
    ?.claims as Record<string, unknown> | undefined;
  const sub = claims?.sub;
  if (typeof sub !== 'string' || !sub) throw new HttpError(401, 'No autorizado');
  return { adminId: sub };
}
