# backend/src

Estructura prevista (se implementa a partir de la etapa 2):

- `handlers/public/` — endpoints de la paciente.
- `handlers/admin/` — endpoints administrativos (Cognito).
- `handlers/authorizers/` — Lambda authorizer del token de sesión.
- `domain/` — PIN, reto, sesión y normalización de identidad.
- `security/` — `node:crypto` (aleatoriedad, HMAC, comparación en tiempo constante) y secretos.
- `sms/` — `SmsProvider`, `MockSmsProvider`, `AwsSnsSmsProvider` (stub).
- `repositories/` — acceso a DynamoDB.
- `audit/` — eventos de auditoría sin datos personales.
- `http/` — validación, errores genéricos y respuestas.
- `observability/` — logger con redacción y métricas.
