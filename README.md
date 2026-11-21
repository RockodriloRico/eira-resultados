# eira-resultados

Plataforma de entrega digital segura y trazable de resultados para EIRA Movimiento Rosa A.C.

> **Estado: etapa 0 — estructura base.** Aún no hay endpoints, infraestructura ni flujo de acceso implementados.
> El proyecto usa exclusivamente **datos sintéticos** y **no despliega recursos en AWS**.

## Estructura

```
├── frontend/            # React + TypeScript + Vite (CSS Modules)
├── backend/             # AWS Lambda (Node.js 24, TypeScript)
├── packages/shared/     # Contratos y constantes compartidas (@eira/shared)
├── infrastructure/      # AWS SAM (plantilla a partir de la etapa 1)
├── scripts/             # Utilidades locales (datos sintéticos)
├── docs/                # Arquitectura, modelo de datos, requisitos y ADRs
└── .github/workflows/   # CI sin despliegue
```

## Requisitos

- Node.js **24.x LTS** (ver `.nvmrc`) y npm ≥ 11.
- AWS SAM CLI ≥ 1.174.0 y Docker, solo a partir de la etapa 1.

Detalles e instalación: [docs/requirements.md](docs/requirements.md).

## Ejecución local

```bash
npm ci
npm run check                  # formato, lint, tipos, pruebas y build
npm run dev -w @eira/frontend  # http://localhost:5173
```

## Documentación

- [Arquitectura](docs/architecture.md)
- [Modelo de datos](docs/data-model.md)
- [Decisiones (ADR)](docs/adr/)

## Plan por etapas

| Etapa | Alcance                                              | Estado      |
| ----- | ---------------------------------------------------- | ----------- |
| 0     | Estructura base, lint, pruebas, CI                   | En revisión |
| 1     | Plantilla AWS SAM (sin desplegar)                    | Pendiente   |
| 2     | Núcleo de seguridad (PIN, HMAC, SMS mock)            | Pendiente   |
| 3     | API de paciente                                      | Pendiente   |
| 4     | Frontend de paciente                                 | Pendiente   |
| 5     | Administración (Cognito)                             | Pendiente   |
| 6     | Observabilidad, datos sintéticos, modelo de amenazas | Pendiente   |

## Licencia

[MIT](LICENSE)
