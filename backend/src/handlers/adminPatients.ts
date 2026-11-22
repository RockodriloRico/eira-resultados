import { container } from '../app/container.ts';
import { adminPatientsRoute } from '../http/adminRoutes.ts';
import { httpHandler } from '../http/handler.ts';

export const handler = httpHandler(
  adminPatientsRoute(() => container().patients),
  () => container().config.corsAllowedOrigin,
);
