# ADR-0001: Monorepo con npm workspaces

- Estado: Aceptada

## Contexto

El frontend, el backend y la infraestructura comparten contratos (constantes de seguridad, esquemas de la API) y deben versionarse juntos.

## Decisión

- Un solo repositorio con npm workspaces: `packages/shared`, `backend` y `frontend`. `infrastructure/`, `scripts/` y `docs/` no son workspaces.
- `packages/shared` exporta código TypeScript fuente; Vite, esbuild y Vitest lo consumen directamente, sin paso de build.
- Node.js 24 LTS para desarrollo y para Lambda (`nodejs24.x`). Ver [requirements.md](../requirements.md).
- TypeScript `strict` y configuración base compartida (`tsconfig.base.json`).
- ESLint (flat config) con `typescript-eslint`, `eslint-plugin-security` en backend y `react-hooks` en frontend. Prettier para formato.
- Vitest en todos los workspaces.
- CI de GitHub Actions solo de validación: formato, lint, tipos, pruebas, build, `npm audit` y gitleaks. Sin credenciales de AWS ni despliegue. Acciones fijadas por SHA.
- TypeScript se fija en `~6.0`: `typescript-eslint` aún no soporta TypeScript 7.

## Consecuencias

- Un único `package-lock.json` y un solo comando de verificación (`npm run check`).
- Cambios en el contrato compartido se validan en frontend y backend dentro del mismo PR.
