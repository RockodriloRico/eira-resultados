# ADR-0006: Cognito con Authorization Code Flow + PKCE para administración

- Estado: Aceptada

## Decisión

- Un Cognito User Pool exclusivo para personal administrativo: sin auto-registro, MFA TOTP obligatorio y grupo `admins`.
- App client **público** (sin client secret) con **Authorization Code Flow + PKCE** (`S256`). Los flujos implícito y `USER_PASSWORD_AUTH` quedan deshabilitados.
- Callback y logout URLs restringidas al dominio de CloudFront (y a `localhost` solo en `dev`).
- En el frontend: `oidc-client-ts`, con los tokens en memoria.
- API Gateway valida el JWT con un Cognito authorizer y los handlers exigen pertenencia al grupo `admins`.

## Consecuencias

- Las pacientes no usan Cognito; su acceso es por PIN y sesión opaca ([ADR-0002](0002-api-rest-y-sesion-opaca.md)).
