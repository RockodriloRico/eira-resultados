import { container } from '../app/container.ts';
import { adminAuditRoute } from '../http/adminRoutes.ts';
import { httpHandler } from '../http/handler.ts';

export const handler = httpHandler(
  adminAuditRoute(() => container().auditQueries),
  () => container().config.corsAllowedOrigin,
);
