# infrastructure

Infraestructura como código con **AWS SAM** (región prevista: `us-east-1`).

> Etapa 0: esta carpeta solo contiene documentación. La plantilla se crea en la etapa 1.
> **Nunca** se ejecuta `sam deploy` desde este repositorio sin aprobación explícita.

## Contenido previsto (etapa 1)

| Archivo              | Propósito                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `template.yaml`      | KMS, Secrets Manager, DynamoDB, S3 privado (resultados y frontend), CloudFront con OAC, Cognito, API Gateway REST, Lambdas, roles IAM y CloudWatch |
| `samconfig.toml`     | Parámetros por entorno (`dev`, `demo`, `prod`), sin credenciales                                                                                   |
| `env/local-env.json` | Variables para `sam local` con valores ficticios                                                                                                   |
| `docker-compose.yml` | DynamoDB Local para pruebas de integración                                                                                                         |
| `tests/`             | Aserciones sobre `template.yaml` (IAM, S3, KMS, reglas de entorno)                                                                                 |

## Reglas que la plantilla debe hacer cumplir

- `Rules`: la combinación `Stage=prod` + `SmsProvider=mock` hace fallar la plantilla (y con ella el campo `demoPin`).
- Buckets con Block Public Access, SSE-KMS, TLS obligatorio y acceso solo desde roles autorizados o CloudFront (OAC).
- Un rol IAM por función, con acciones y ARNs concretos.
- `AuditLog` sin permisos `UpdateItem`/`DeleteItem` para ningún rol de aplicación (ver [ADR-0004](../docs/adr/0004-auditlog-append-only.md)).

Requisitos de herramientas: ver [docs/requirements.md](../docs/requirements.md).
