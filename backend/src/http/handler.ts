import type { APIGatewayProxyEvent } from 'aws-lambda';
import { logger } from '../observability/logger.ts';
import { GENERIC, HttpError, type HttpResult, json } from './responses.ts';

export type Route = (event: APIGatewayProxyEvent) => Promise<{ status: number; body: unknown }>;

/** Traduce errores a respuestas genéricas sin filtrar detalles internos. */
export function httpHandler(route: Route, origin: () => string | undefined) {
  return async (event: APIGatewayProxyEvent): Promise<HttpResult> => {
    try {
      const { status, body } = await route(event);
      return json(status, body, origin());
    } catch (error) {
      if (error instanceof HttpError)
        return json(error.statusCode, { message: error.message }, origin());
      logger.error('UnhandledError', { error: error instanceof Error ? error.name : 'unknown' });
      return json(500, { message: GENERIC.internal }, origin());
    }
  };
}
