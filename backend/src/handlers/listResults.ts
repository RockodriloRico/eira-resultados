import { container } from '../app/container.ts';
import { httpHandler } from '../http/handler.ts';
import { listResultsRoute } from '../http/patientRoutes.ts';

export const handler = httpHandler(
  listResultsRoute(() => container().patientResults),
  () => container().config.corsAllowedOrigin,
);
