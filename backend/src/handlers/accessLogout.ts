import { container } from '../app/container.ts';
import { httpHandler } from '../http/handler.ts';
import { logoutRoute } from '../http/patientRoutes.ts';

export const handler = httpHandler(
  logoutRoute(() => container().sessions),
  () => container().config.corsAllowedOrigin,
);
