# Requisitos y versiones

| Herramienta   | Versión                                   | Desde la etapa | Uso                                                                             |
| ------------- | ----------------------------------------- | -------------- | ------------------------------------------------------------------------------- |
| Node.js       | **24.x LTS** (≥ 24.11.0, `.nvmrc` = `24`) | 0              | Desarrollo, pruebas y build. Coincide con el runtime `nodejs24.x` de AWS Lambda |
| npm           | ≥ 11 (incluido con Node 24)               | 0              | npm workspaces y `package-lock.json`                                            |
| AWS SAM CLI   | ≥ 1.174.0                                 | 1              | `sam validate --lint`, `sam build`, `sam local` (**sin** `sam deploy`)          |
| Docker        | Engine reciente                           | 1              | `sam local start-api` y DynamoDB Local                                          |
| Python + pipx | 3.11+                                     | 1              | `cfn-lint` y `checkov` (también corren en CI)                                   |

## Por qué Node.js 24

- Es la línea LTS con mayor soporte disponible en Lambda: AWS deja de dar soporte a `nodejs24.x` el 30 de abril de 2028.
- `nodejs22.x` termina antes, y `nodejs26.x` acaba de publicarse (noviembre de 2026); se reevaluará más adelante.
- `package.json` declara `engines` y `.npmrc` usa `engine-strict=true`: `npm ci` falla con una versión de Node incompatible.

## Instalación (referencia; ejecútala tú en tu equipo)

Estos comandos **no** se han ejecutado en tu equipo. Devin solo los documenta.

```bash
# Node.js 24 con nvm (https://github.com/nvm-sh/nvm)
nvm install 24
nvm use

# AWS SAM CLI (a partir de la etapa 1). Instalador oficial:
# https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html
sam --version   # debe ser >= 1.174.0
```

No se requieren credenciales de AWS para ninguna etapa de desarrollo local ni para CI.

## Comandos del proyecto

```bash
npm ci                 # instala dependencias exactamente según package-lock.json
npm run check          # formato + lint + tipos + pruebas + build (lo mismo que CI)

npm run format         # aplica Prettier
npm run lint           # ESLint (TypeScript, React hooks, eslint-plugin-security)
npm run typecheck      # tsc en cada workspace
npm test               # Vitest en cada workspace
npm run build          # build de producción del frontend

npm run dev -w @eira/frontend   # servidor de desarrollo Vite en http://localhost:5173
```
