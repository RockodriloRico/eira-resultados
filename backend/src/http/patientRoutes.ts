import type { APIGatewayProxyEvent, APIGatewayAuthorizerResult } from 'aws-lambda';
import { entityIdSchema } from '@eira/shared';
import type { PatientResultsService } from '../services/patientResultsService.ts';
import type { SessionPrincipal, SessionService } from '../services/sessionService.ts';
import type { Route } from './handler.ts';
import { parseWith, requestMeta, sessionContext } from './responses.ts';

export const logoutRoute =
  (service: () => SessionService): Route =>
  async (event: APIGatewayProxyEvent) => {
    await service().logout(sessionContext(event), requestMeta(event));
    return { status: 204, body: undefined };
  };

export const listResultsRoute =
  (service: () => PatientResultsService): Route =>
  async (event: APIGatewayProxyEvent) => {
    const { patientId } = sessionContext(event);
    return { status: 200, body: { results: await service().list(patientId, requestMeta(event)) } };
  };

const resultIdSchema = entityIdSchema('res');
export const downloadUrlRoute =
  (service: () => PatientResultsService): Route =>
  async (event: APIGatewayProxyEvent) => {
    const { patientId } = sessionContext(event);
    const resultId = parseWith(resultIdSchema, event.pathParameters?.resultId);
    return {
      status: 200,
      body: await service().downloadUrl(patientId, resultId, requestMeta(event)),
    };
  };

/** Política del authorizer REQUEST: Allow solo sobre el método invocado, con el contexto de sesión. */
export function authorizerPolicy(
  principal: SessionPrincipal,
  methodArn: string,
): APIGatewayAuthorizerResult {
  return {
    principalId: 'patient-session',
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{ Action: 'execute-api:Invoke', Effect: 'Allow', Resource: methodArn }],
    },
    context: { patientId: principal.patientId, tokenHash: principal.tokenHash },
  };
}

export const headerValue = (
  headers: Record<string, string | undefined> | null | undefined,
  name: string,
) => {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {}))
    if (key.toLowerCase() === lower) return value;
  return undefined;
};
