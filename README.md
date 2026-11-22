# eira-resultados

Plataforma de entrega digital segura y trazable de resultados para EIRA Movimiento Rosa A.C.

> **Estado: etapa 0 — estructura base.** Aún no hay endpoints, infraestructura ni flujo de acceso implementados.
> El proyecto usa exclusivamente **datos sintéticos** y **no despliega recursos en AWS**.

## Estructura

```
├── frontend/            # React + TypeScript + Vite (CSS Modules)
├── backend/             # AWS Lambda (Node.js 24, TypeScript)
├── packages/shared/     # Contratos y constantes compartidas (@eira/shared)
├── infrastructure/      # AWS SAM: plantilla, pruebas y DynamoDB Local (sin despliegue)
├── scripts/             # Utilidades locales (datos sintéticos)
├── docs/                # Arquitectura, modelo de datos, requisitos y ADRs
└── .github/workflows/   # CI sin despliegue
```

## Requisitos

- Node.js **24.x LTS** (ver `.nvmrc`) y npm ≥ 11.
- AWS SAM CLI 1.174.0, Python 3.10+ y Docker para la infraestructura (etapa 1).

Detalles e instalación: [docs/requirements.md](docs/requirements.md).

## Ejecución local

```bash
npm ci
npm run check                  # formato, lint, tipos, pruebas y build
npm run demo                   # demo completa (requiere Docker): http://127.0.0.1:5173
```

La demo levanta DynamoDB Local, la API local (`127.0.0.1:3001`, mismos handlers que las Lambdas) y
Vite (`127.0.0.1:5173`). Solo usa datos sintéticos, `MockSmsProvider` y el `demoPin` en pantalla;
no usa AWS ni credenciales.

- **Paciente:** `#/` con `Ana Prueba Sintética`, `1985-03-14`, `SINT-0001` (o `SINT-0002`:
  `Beatriz Ejemplo Ficticia`, `1990-11-02`).
- **Administración:** `#/admin`, con una identidad sintética que solo existe en el servidor local.
  En AWS la administración usa Cognito.

## Documentación

- [Arquitectura](docs/architecture.md)
- [Modelo de datos](docs/data-model.md)
- [Decisiones (ADR)](docs/adr/)

## Plan por etapas

| Etapa | Alcance                                              | Estado      |
| ----- | ---------------------------------------------------- | ----------- |
| 0     | Estructura base, lint, pruebas, CI                   | Completada  |
| 1     | Plantilla AWS SAM (sin desplegar)                    | En revisión |
| 2     | Núcleo de seguridad (PIN, HMAC, SMS mock)            | Pendiente   |
| 3     | API de paciente                                      | Pendiente   |
| 4     | Frontend de paciente                                 | Pendiente   |
| 5     | Administración (Cognito)                             | Pendiente   |
| 6     | Observabilidad, datos sintéticos, modelo de amenazas | Pendiente   |

## Licencia

[MIT](LICENSE)
