import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { SECURITY_POLICY } from '@eira/shared';
import {
  createLocalTables,
  localClient,
  waitForLocal,
} from '../../../infrastructure/scripts/local-tables.ts';
import { buildContainer, type Container } from '../app/container.ts';
import { loadConfig } from '../config.ts';
import { requestRoute, resendRoute, verifyRoute } from '../http/accessRoutes.ts';
import {
  adminAuditRoute,
  adminPatientsRoute,
  adminResultsRoute,
  adminReviewUrlRoute,
} from '../http/adminRoutes.ts';
import { httpHandler, type Route } from '../http/handler.ts';
import { downloadUrlRoute, listResultsRoute, logoutRoute } from '../http/patientRoutes.ts';
import { HttpError, LOCAL_ADMIN_TOKEN } from '../http/responses.ts';
import { createDb } from '../repositories/db.ts';
import { StaticSecretsProvider } from '../security/secrets.ts';
import { MockSmsProvider } from '../sms/SmsProvider.ts';
import { LocalDocumentStorage } from '../storage/DocumentStorage.ts';
import { seedSynthetic } from './seed.ts';

/**
 * Servidor de demostración SOLO LOCAL. Ejecuta los mismos routes que las Lambdas imitando a API
 * Gateway (authorizer de sesión para pacientes y claims de Cognito para administración).
 * La identidad administrativa sintética existe solo aquí; este archivo no entra en los paquetes
 * Lambda (el build solo empaqueta src/handlers) y se niega a arrancar dentro de AWS.
 */
export const LOCAL_HOST = '127.0.0.1';
export const SYNTHETIC_ADMIN_SUB = 'local-admin-sintetico';
const MAX_JSON_BYTES = 16 * 1024;

type Auth = 'none' | 'session' | 'admin';
type Entry = { method: string; resource: string; auth: Auth; route: Route };

export function assertLocalOnly(env: NodeJS.ProcessEnv = process.env): void {
  const awsMarkers = ['AWS_LAMBDA_FUNCTION_NAME', 'AWS_EXECUTION_ENV', 'LAMBDA_TASK_ROOT'];
  // eslint-disable-next-line security/detect-object-injection -- nombres fijos
  if (awsMarkers.some((name) => env[name])) {
    throw new Error('El servidor local no puede ejecutarse en AWS');
  }
}

function routes(c: Container): Entry[] {
  const floor = () => c.config.minResponseMs;
  return [
    {
      method: 'POST',
      resource: '/v1/access/request',
      auth: 'none',
      route: requestRoute(() => c.access, floor),
    },
    {
      method: 'POST',
      resource: '/v1/access/resend',
      auth: 'none',
      route: resendRoute(() => c.access, floor),
    },
    {
      method: 'POST',
      resource: '/v1/access/verify',
      auth: 'none',
      route: verifyRoute(() => c.access),
    },
    {
      method: 'POST',
      resource: '/v1/access/logout',
      auth: 'session',
      route: logoutRoute(() => c.sessions),
    },
    {
      method: 'GET',
      resource: '/v1/results',
      auth: 'session',
      route: listResultsRoute(() => c.patientResults),
    },
    {
      method: 'POST',
      resource: '/v1/results/{resultId}/download-url',
      auth: 'session',
      route: downloadUrlRoute(() => c.patientResults),
    },
    ...[
      'POST /v1/admin/patients',
      'GET /v1/admin/patients',
      'GET /v1/admin/patients/{patientId}',
    ].map((k) =>
      admin(
        k,
        adminPatientsRoute(() => c.patients),
      ),
    ),
    ...[
      'POST /v1/admin/results',
      'GET /v1/admin/patients/{patientId}/results',
      'POST /v1/admin/results/{resultId}/upload-url',
      'POST /v1/admin/results/{resultId}/submit',
      'POST /v1/admin/results/{resultId}/review',
    ].map((k) =>
      admin(
        k,
        adminResultsRoute(
          () => c.results,
          () => c.documents,
        ),
      ),
    ),
    admin(
      'POST /v1/admin/results/{resultId}/review-url',
      adminReviewUrlRoute(() => c.documents),
    ),
    admin(
      'GET /v1/admin/audit',
      adminAuditRoute(() => c.auditQueries),
    ),
  ];
}
const admin = (key: string, route: Route): Entry => {
  const [method, resource] = key.split(' ') as [string, string];
  return { method, resource, auth: 'admin', route };
};

function match(entries: Entry[], method: string, path: string) {
  const parts = path.split('/');
  for (const entry of entries) {
    if (entry.method !== method) continue;
    const tpl = entry.resource.split('/');
    if (tpl.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const ok = tpl.every((seg, i) => {
      const m = /^\{(\w+)\}$/.exec(seg);
      // eslint-disable-next-line security/detect-object-injection -- índices del propio arreglo
      if (m) return ((params[m[1]!] = decodeURIComponent(parts[i]!)), true);
      // eslint-disable-next-line security/detect-object-injection -- índices del propio arreglo
      return seg === parts[i];
    });
    if (ok) return { entry, params };
  }
  return undefined;
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength;
    if (size > limit) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function send(
  res: ServerResponse,
  status: number,
  body?: string | Uint8Array,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

export async function startDevServer(options: {
  port?: number;
  stage?: string;
  dataDir: string;
  publicUrl?: string;
  minResponseMs?: number;
  seed?: boolean;
}): Promise<{ url: string; server: Server; container: Container; close: () => Promise<void> }> {
  assertLocalOnly();
  const stage = options.stage ?? 'local';
  const raw = localClient();
  await waitForLocal(raw);
  await createLocalTables(raw, stage);
  const config = loadConfig({
    STAGE: 'demo',
    SMS_PROVIDER: 'mock',
    DEMO_PIN_ENABLED: 'true',
    MIN_RESPONSE_MS: String(options.minResponseMs ?? 1000),
  });
  const t = (name: string) => `eira-${stage}-${name}`;
  config.tables = {
    patients: t('Patients'),
    pinChallenges: t('PinChallenges'),
    accessSessions: t('AccessSessions'),
    results: t('Results'),
    auditLog: t('AuditLog'),
  };
  // Secretos fijos y públicos: solo protegen datos sintéticos en DynamoDB Local.
  const secrets = new StaticSecretsProvider({
    identity: 'local-identity-secret-solo-demo-0001',
    pin: 'local-pin-secret-solo-demo-000000001',
  });
  // El puerto se conoce al escuchar; las URL firmadas apuntan aquí o al proxy del frontend.
  let handle: (req: IncomingMessage, res: ServerResponse) => Promise<void> = async (_q, res) =>
    send(res, 503);
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => send(res, 500, JSON.stringify({ message: 'Error interno' })));
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 3001, LOCAL_HOST, resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://${LOCAL_HOST}:${port}`;
  const storage = new LocalDocumentStorage({
    dir: `${options.dataDir}/documents`,
    baseUrl: options.publicUrl ?? url,
    secret: 'local-document-secret-solo-demo-001',
  });
  const container = buildContainer(config, {
    db: createDb({
      endpoint: process.env.DYNAMODB_LOCAL_ENDPOINT ?? 'http://127.0.0.1:8000',
      region: 'us-east-1',
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    }),
    secrets,
    sms: new MockSmsProvider(),
    storage,
  });
  if (options.seed !== false) {
    await seedSynthetic({
      patients: container.patients,
      results: container.results,
      storage,
    }).catch((error: unknown) => {
      if (!(error instanceof HttpError && error.statusCode === 409)) throw error;
    });
  }
  const entries = routes(container);

  handle = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/local-documents' && req.method === 'GET') {
      const pdf = await storage.open(url.searchParams);
      if (!pdf) return send(res, 403);
      return send(res, 200, pdf, {
        'content-type': 'application/pdf',
        'content-disposition': 'inline; filename="resultado.pdf"',
      });
    }
    if (url.pathname === '/local-documents/upload' && req.method === 'PUT') {
      const body = await readBody(req, SECURITY_POLICY.maxDocumentBytes);
      const checksum = req.headers['x-amz-checksum-sha256'];
      const ok =
        body !== undefined &&
        req.headers['if-none-match'] === '*' &&
        (await storage.acceptUpload(
          url.searchParams,
          typeof checksum === 'string' ? checksum : undefined,
          body,
        ));
      return send(res, ok ? 200 : 403);
    }
    const found = match(entries, req.method ?? '', url.pathname);
    if (!found)
      return send(res, 404, JSON.stringify({ message: 'No encontrado' }), {
        'content-type': 'application/json',
      });
    const body = await readBody(req, MAX_JSON_BYTES);
    if (body === undefined) return send(res, 413);
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : (v ?? '')]),
    );
    let authorizer: Record<string, unknown> | null = null;
    if (found.entry.auth === 'session') {
      const principal = await container.sessions.authorize(headers.authorization);
      if (!principal)
        return send(res, 401, JSON.stringify({ message: 'Unauthorized' }), {
          'content-type': 'application/json',
        });
      authorizer = { patientId: principal.patientId, tokenHash: principal.tokenHash };
    } else if (found.entry.auth === 'admin') {
      authorizer = {
        claims: {
          sub: SYNTHETIC_ADMIN_SUB,
          'cognito:groups': 'admins',
          token_use: 'access',
          client_id: LOCAL_ADMIN_TOKEN.clientId,
          iss: LOCAL_ADMIN_TOKEN.issuer,
        },
      };
    }
    const query = Object.fromEntries(url.searchParams);
    const event = {
      httpMethod: found.entry.method,
      resource: found.entry.resource,
      path: url.pathname,
      headers,
      body: body.byteLength ? body.toString('utf8') : null,
      pathParameters: Object.keys(found.params).length ? found.params : null,
      queryStringParameters: Object.keys(query).length ? query : null,
      requestContext: {
        requestId: randomUUID(),
        identity: { sourceIp: req.socket.remoteAddress ?? LOCAL_HOST },
        authorizer,
      },
    } as unknown as APIGatewayProxyEvent;
    const out = await httpHandler(found.entry.route, () => undefined)(event);
    send(res, out.statusCode, out.body, (out.headers ?? {}) as Record<string, string>);
  };
  return {
    url,
    server,
    container,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
