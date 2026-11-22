import type { APIGatewayProxyEvent } from 'aws-lambda';
import { accessRequestBody, resendBody, verifyBody } from '@eira/shared';
import type { AccessService } from '../services/accessService.ts';
import type { Route } from './handler.ts';
import { withResponseFloor } from './responseFloor.ts';
import { parseJson, requestMeta } from './responses.ts';

/** POST /v1/access/request: siempre 202 con el mismo esquema, exista o no el expediente. */
export const requestRoute =
  (service: () => AccessService, minResponseMs: () => number): Route =>
  (event: APIGatewayProxyEvent) =>
    withResponseFloor(minResponseMs(), async () => {
      const body = parseJson(accessRequestBody, event.body);
      return { status: 202, body: await service().request(body, requestMeta(event)) };
    });

/** POST /v1/access/resend: mismo esquema para retos reales y señuelo. */
export const resendRoute =
  (service: () => AccessService, minResponseMs: () => number): Route =>
  (event: APIGatewayProxyEvent) =>
    withResponseFloor(minResponseMs(), async () => {
      const { challengeId } = parseJson(resendBody, event.body);
      return { status: 202, body: await service().resend(challengeId, requestMeta(event)) };
    });

/** POST /v1/access/verify: el resultado es observable por diseño. */
export const verifyRoute =
  (service: () => AccessService): Route =>
  async (event: APIGatewayProxyEvent) => {
    const body = parseJson(verifyBody, event.body);
    return { status: 200, body: await service().verify(body, requestMeta(event)) };
  };
