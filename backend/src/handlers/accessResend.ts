import { container } from '../app/container.ts';
import { resendRoute } from '../http/accessRoutes.ts';
import { httpHandler } from '../http/handler.ts';

export const handler = httpHandler(
  resendRoute(
    () => container().access,
    () => container().config.minResponseMs,
  ),
  () => container().config.corsAllowedOrigin,
);
