import { container } from '../app/container.ts';
import { adminReviewUrlRoute } from '../http/adminRoutes.ts';
import { httpHandler } from '../http/handler.ts';

export const handler = httpHandler(
  adminReviewUrlRoute(() => container().documents),
  () => container().config.corsAllowedOrigin,
);
