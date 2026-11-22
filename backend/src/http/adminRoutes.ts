import type { APIGatewayProxyEvent } from 'aws-lambda';
import {
  auditQuery,
  createPatientBody,
  createResultBody,
  entityIdSchema,
  findPatientQuery,
  reviewBody,
  submitDocumentBody,
  uploadUrlBody,
} from '@eira/shared';
import type { AuditQueryService } from '../services/auditQueryService.ts';
import type { DocumentService } from '../services/documentService.ts';
import type { PatientService } from '../services/patientService.ts';
import type { ResultService } from '../services/resultService.ts';
import type { Route } from './handler.ts';
import { GENERIC, HttpError, adminContext, parseJson, parseWith } from './responses.ts';

type Handlers = Record<
  string,
  (event: APIGatewayProxyEvent) => Promise<{ status: number; body: unknown }>
>;

/** Una Lambda atiende varias rutas: se despacha por método y recurso de API Gateway. */
const router =
  (handlers: Handlers): Route =>
  (event) => {
    const handler = handlers[`${event.httpMethod} ${event.resource}`];
    if (!handler) throw new HttpError(404, GENERIC.notFound);
    return handler(event);
  };

const meta = (event: APIGatewayProxyEvent) => ({
  ...adminContext(event),
  requestId: event.requestContext?.requestId ?? 'local',
});
const patientId = (event: APIGatewayProxyEvent) =>
  parseWith(entityIdSchema('pat'), event.pathParameters?.patientId);
const resultId = (event: APIGatewayProxyEvent) =>
  parseWith(entityIdSchema('res'), event.pathParameters?.resultId);
const found = <T>(value: T | undefined): T => {
  if (value === undefined) throw new HttpError(404, GENERIC.notFound);
  return value;
};

export const adminPatientsRoute = (service: () => PatientService): Route =>
  router({
    'POST /v1/admin/patients': async (e) => {
      const m = meta(e);
      return { status: 201, body: await service().create(parseJson(createPatientBody, e.body), m) };
    },
    'GET /v1/admin/patients': async (e) => {
      const m = meta(e);
      const { folio } = parseWith(findPatientQuery, e.queryStringParameters ?? {});
      return { status: 200, body: found(await service().findByFolio(folio, m)) };
    },
    'GET /v1/admin/patients/{patientId}': async (e) => {
      const m = meta(e);
      return { status: 200, body: found(await service().get(patientId(e), m)) };
    },
  });

export const adminResultsRoute = (
  results: () => ResultService,
  documents: () => DocumentService,
): Route =>
  router({
    'POST /v1/admin/results': async (e) => {
      const m = meta(e);
      return { status: 201, body: await results().create(parseJson(createResultBody, e.body), m) };
    },
    'GET /v1/admin/patients/{patientId}/results': async (e) => {
      meta(e);
      return { status: 200, body: { results: await results().listForAdmin(patientId(e)) } };
    },
    'POST /v1/admin/results/{resultId}/upload-url': async (e) => {
      const m = meta(e);
      const { sha256, sizeBytes } = parseJson(uploadUrlBody, e.body);
      return {
        status: 200,
        body: await documents().uploadUrl(resultId(e), { sha256, sizeBytes }, m),
      };
    },
    'POST /v1/admin/results/{resultId}/submit': async (e) => {
      const m = meta(e);
      const spec = parseJson(submitDocumentBody, e.body);
      return { status: 200, body: await documents().submit(resultId(e), spec, m) };
    },
    'POST /v1/admin/results/{resultId}/review': async (e) => {
      const m = meta(e);
      return {
        status: 200,
        body: await results().review(resultId(e), parseJson(reviewBody, e.body), m),
      };
    },
  });

export const adminReviewUrlRoute = (documents: () => DocumentService): Route =>
  router({
    'POST /v1/admin/results/{resultId}/review-url': async (e) => {
      const m = meta(e);
      return { status: 200, body: await documents().reviewUrl(resultId(e), m) };
    },
  });

export const adminAuditRoute = (service: () => AuditQueryService): Route =>
  router({
    'GET /v1/admin/audit': async (e) => {
      const m = meta(e);
      const query = parseWith(auditQuery, e.queryStringParameters ?? {});
      return { status: 200, body: await service().query(query, m) };
    },
  });
