import { container } from '../app/container.ts';
import { requestRoute } from '../http/accessRoutes.ts';
import { httpHandler } from '../http/handler.ts';

export const handler = httpHandler(
  requestRoute(
    () => container().access,
    () => container().config.minResponseMs,
  ),
  () => container().config.corsAllowedOrigin,
);
