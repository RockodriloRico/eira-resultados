# ADR-0006: Cognito con Authorization Code Flow + PKCE para administración

- Estado: Aceptada

## Decisión

- Un Cognito User Pool exclusivo para personal administrativo: sin auto-registro, MFA TOTP obligatorio y grupo `admins`.
- App client **público** (sin client secret) con **Authorization Code Flow + PKCE** (`S256`). Los flujos implícito y `USER_PASSWORD_AUTH` quedan deshabilitados.
- Callback y logout URLs restringidas al dominio de CloudFront (y a `localhost` solo en `dev`).
- En el frontend: `oidc-client-ts`, con los tokens en memoria.
- API Gateway valida el **access token** (`AuthorizationScopes: [openid]`); el frontend no envía el ID token.
- API Gateway valida el JWT con un Cognito authorizer y los handlers exigen pertenencia al grupo `admins`.

## Consecuencias

- Las pacientes no usan Cognito; su acceso es por PIN y sesión opaca ([ADR-0002](0002-api-rest-y-sesion-opaca.md)).

## Implementación en el frontend (etapa 3)

- `frontend/src/admin/auth.ts` configura `UserManager` con `InMemoryWebStorage` para `userStore` y `stateStore`: ni tokens ni `code_verifier`/`state` tocan `localStorage` o `sessionStorage`.
- El inicio de sesión abre el Hosted UI en **ventana emergente** (`signinPopup`). La página principal no navega, así que el estado PKCE en memoria sobrevive; `/admin/callback` solo devuelve la respuesta a la ventana principal, que valida `state` e intercambia el código con el `code_verifier`.
- Metadatos OIDC explícitos (sin descargar el discovery). Sin `client_secret`.
- Renovación con refresh token mediante `fetch` (sin iframes, que la CSP no permite). Si falla o el token vence, se vuelve a la pantalla de inicio de sesión; un `401` de la API hace lo mismo.
- Cierre de sesión: revoca el refresh token (`/oauth2/revoke`), descarta los tokens y navega a `/logout` de Cognito con `client_id` y `logout_uri` (`/admin`).
- Recargar la página o cerrar la pestaña termina la sesión del portal: es el costo de no persistir tokens.
- La identidad sintética solo existe con `config.json` en modo `local` y el servidor de `127.0.0.1`.
- El backend responde `401` sin `sub` y `403` si `cognito:groups` no es exactamente `admins` (o `[admins]`). No se separa por comas ni espacios, porque un nombre de grupo de Cognito puede contenerlos; pertenecer a otro grupo además de `admins` también da `403`.
- La sesión vive en un `UserManager` único por página: cambiar de sección no la pierde.
