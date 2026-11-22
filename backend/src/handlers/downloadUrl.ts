import { container } from '../app/container.ts';
import { httpHandler } from '../http/handler.ts';
import { downloadUrlRoute } from '../http/patientRoutes.ts';

export const handler = httpHandler(
  downloadUrlRoute(() => container().patientResults),
  () => container().config.corsAllowedOrigin,
);
