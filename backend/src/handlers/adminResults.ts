import { container } from '../app/container.ts';
import { adminResultsRoute } from '../http/adminRoutes.ts';
import { httpHandler } from '../http/handler.ts';

export const handler = httpHandler(
  adminResultsRoute(
    () => container().results,
    () => container().documents,
  ),
  () => container().config.corsAllowedOrigin,
);
