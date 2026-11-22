import { container } from '../app/container.ts';
import { verifyRoute } from '../http/accessRoutes.ts';
import { httpHandler } from '../http/handler.ts';

export const handler = httpHandler(
  verifyRoute(() => container().access),
  () => container().config.corsAllowedOrigin,
);
