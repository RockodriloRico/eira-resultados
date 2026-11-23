import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { logger } from '../observability/logger.ts';
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

export const ADMIN_GROUP = 'admins';

/**
 * El claim `cognito:groups` debe contener exactamente el grupo `admins`. API Gateway REST lo entrega
 * como texto (`admins` o `[admins]`); no se separa por comas ni espacios porque un nombre de grupo
 * de Cognito puede contenerlos (`otros,admins` no es `admins`). Pertenecer a otros grupos además de
 * `admins` se rechaza (falla cerrada): la plantilla solo define `admins`.
 */
export function isAdminGroupClaim(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 1 && value[0] === ADMIN_GROUP;
  return value === ADMIN_GROUP || value === `[${ADMIN_GROUP}]`;
}

export type AdminTokenExpectations = { clientId: string; issuer: string };

/** Cliente y emisor del servidor local; nunca se aceptan dentro de Lambda. */
export const LOCAL_ADMIN_TOKEN: AdminTokenExpectations = {
  clientId: 'local-admin-spa',
  issuer: 'http://127.0.0.1/local-admin-issuer',
};

/**
 * Cliente y emisor esperados del access token. En Lambda salen de `ADMIN_CLIENT_ID` y
 * `ADMIN_TOKEN_ISSUER` (plantilla); si faltan, no hay valores válidos y toda petición recibe 401.
 */
export function adminTokenExpectations(
  env: NodeJS.ProcessEnv = process.env,
): AdminTokenExpectations | undefined {
  if (env.ADMIN_CLIENT_ID && env.ADMIN_TOKEN_ISSUER)
    return { clientId: env.ADMIN_CLIENT_ID, issuer: env.ADMIN_TOKEN_ISSUER };
  return env.AWS_LAMBDA_FUNCTION_NAME ? undefined : LOCAL_ADMIN_TOKEN;
}

/**
 * Identidad del administrador (ADR-0006). El Cognito authorizer de API Gateway ya verificó la firma
 * (JWKS del User Pool), el emisor del pool y la expiración, y con `AuthorizationScopes` solo acepta
 * access tokens. Aquí se exige además, en defensa en profundidad: `token_use=access`, el emisor y el
 * `client_id` del cliente administrativo (el authorizer no comprueba el cliente) y el grupo `admins`.
 */
export function adminContext(
  event: APIGatewayProxyEvent,
  expected: AdminTokenExpectations | undefined = adminTokenExpectations(),
): { adminId: string } {
  const claims = (event.requestContext?.authorizer as Record<string, unknown> | null | undefined)
    ?.claims as Record<string, unknown> | undefined;
  const sub = claims?.sub;
  if (typeof sub !== 'string' || !sub) throw new HttpError(401, 'No autorizado');
  if (
    !expected ||
    claims?.token_use !== 'access' ||
    claims?.client_id !== expected.clientId ||
    claims?.iss !== expected.issuer
  )
    throw new HttpError(401, 'No autorizado');
  if (!isAdminGroupClaim(claims?.['cognito:groups'])) {
    logger.metric('AdminForbidden');
    throw new HttpError(403, 'Acceso restringido al personal autorizado');
  }
  return { adminId: sub };
}
