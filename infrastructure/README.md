# infrastructure

Infraestructura como código con **AWS SAM** (región prevista: `us-east-1`).

> **Etapa 1: solo definición.** Ningún recurso de esta plantilla está desplegado ni creado en AWS.
> No se ejecuta `sam deploy` ni `aws cloudformation deploy`, y no se usan credenciales de AWS
> (ni en local ni en CI). Definir un recurso no autoriza su despliegue.

## Archivos

| Archivo                                    | Propósito                                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `template.yaml`                            | Plantilla SAM/CloudFormation completa (recursos abajo)                                        |
| `samconfig.toml`                           | Parámetros por entorno (`dev`, `demo`, `prod`); sin perfiles, cuentas ni credenciales         |
| `env/local-env.json`                       | Variables ficticias para `sam local` (tablas `eira-local-*`, ARN con cuenta `000000000000`)   |
| `docker-compose.yml`                       | DynamoDB Local en memoria, publicado solo en `127.0.0.1:8000`                                 |
| `scripts/local-tables.ts`                  | Crea en DynamoDB Local las tablas derivadas de `template.yaml` (rechaza endpoints no locales) |
| `scripts/translate_sam.py`                 | Traduce la plantilla con el traductor de SAM, sin AWS, para pasar cfn-lint al resultado       |
| `tests/template.test.ts`                   | Pruebas estáticas: Rules, Conditions, tablas, KMS, S3, OAC, WAF, IAM, Lambda, outputs         |
| `tests/dynamodb-local.integration.test.ts` | Esquema real en DynamoDB Local: 5 tablas, TTL, GSI y escritura append-only (datos sintéticos) |
| `requirements-*.txt`                       | Versiones fijadas de SAM CLI + cfn-lint y de Checkov (entornos virtuales separados)           |

## Recursos definidos

| Grupo           | Recursos                                                                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KMS             | `DataKey` (DynamoDB, Secrets Manager, CloudWatch Logs) y `DocumentsKey` (solo S3 de documentos), ambas con rotación ([ADR-0009](../docs/adr/0009-kms-y-secretos.md)) |
| Secrets Manager | `IdentityHmacSecret` y `PinHmacSecret`, generados por CloudFormation (el valor nunca está en el repositorio)                                                         |
| DynamoDB        | `Patients`, `PinChallenges`, `AccessSessions`, `Results`, `AuditLog` ([data-model.md](../docs/data-model.md)); sin `RateLimits`                                      |
| S3              | `DocumentsBucket` (SSE-KMS con `DocumentsKey`) y `FrontendBucket` (SSE-S3), ambos privados                                                                           |
| CloudFront      | Distribución con OAC (SigV4 siempre), fallback SPA y cabeceras de seguridad                                                                                          |
| Cognito         | User pool de administración (Essentials, solo alta por admin, MFA TOTP obligatorio), cliente público con Authorization Code (PKCE en el cliente)                     |
| API Gateway     | REST regional con 9 rutas, authorizer de sesión sin caché, authorizer Cognito, throttling por ruta, access logs sin cuerpos y respuestas de error genéricas          |
| WAF             | Web ACL regional con 3 grupos administrados y 3 reglas rate-based por IP (429), asociado al stage                                                                    |
| Lambda          | 10 esqueletos `nodejs24.x` / `arm64`: responden `501`; el authorizer deniega todo                                                                                    |
| IAM             | Un rol por función (10), con ARNs concretos y condiciones                                                                                                            |
| CloudWatch      | Un log group por función y otro para access logs, cifrados con `DataKey` y con retención por entorno                                                                 |

## Entornos y reglas

| Parámetro                            | dev     | demo    | prod                          |
| ------------------------------------ | ------- | ------- | ----------------------------- |
| `SmsProvider`                        | `mock`  | `mock`  | `sns` (obligatorio no-`mock`) |
| `EnableWaf`                          | `false` | `true`  | `true` (obligatorio)          |
| `demoPin`                            | no      | sí      | imposible                     |
| Retención logs                       | 14 días | 30 días | 365 días                      |
| Protección borrado (tablas, Cognito) | no      | no      | sí                            |

- **`Rules`** (CloudFormation las evalúa antes de crear o modificar recursos): `Stage=prod` exige `EnableWaf=true` y prohíbe `SmsProvider=mock`.
- **`Conditions`**: `CreateWaf = IsProd OR EnableWaf=true`, de modo que en `prod` el WAF se crea aunque alguien elimine las `Rules`. `ExposeDemoPin` solo con `demo` + `mock`.
- Ninguna herramienta local evalúa las `Rules` con valores concretos; por eso `tests/cfn.ts` incluye un evaluador propio probado contra todas las combinaciones.
- El dato `SYNTHETIC` obligatorio en demo y el rechazo de registros no sintéticos se implementan en la lógica (etapa 2); la plantilla solo etiqueta la clasificación.

## Comandos (todos locales)

```bash
# Herramientas en entornos virtuales separados (aws-sam-cli y checkov tienen dependencias incompatibles)
python3 -m venv ~/.venvs/eira-sam && ~/.venvs/eira-sam/bin/pip install -r infrastructure/requirements-sam.txt
python3 -m venv ~/.venvs/eira-checkov && ~/.venvs/eira-checkov/bin/pip install -r infrastructure/requirements-checkov.txt
export PATH="$HOME/.venvs/eira-sam/bin:$HOME/.venvs/eira-checkov/bin:$PATH" SAM_CLI_TELEMETRY=0

npm run infra:validate                    # sam validate --lint + cfn-lint
npm run infra:checkov                     # Checkov
npm run build:sam -w @eira/infrastructure # esbuild + sam build (nodejs24.x, arm64)
npm test -w @eira/infrastructure          # pruebas estáticas de la plantilla

npm run dynamodb:up                       # DynamoDB Local (Docker)
npm run dynamodb:tables -w @eira/infrastructure
npm run test:integration
npm run dynamodb:down
```

## Omisiones de Checkov justificadas

Cada omisión está en el `Metadata.checkov.skip` del recurso, con su motivo. Resumen:

| Control                                             | Motivo                                                                                                                                                    |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CKV_AWS_115/116/117/173/272` (Lambda)              | Sin concurrencia reservada ni VPC (decisión 10); DLQ no aplica a invocación síncrona; variables sin secretos; firma de código antes del primer despliegue |
| `CKV_AWS_120`, `CKV_AWS_73`, `CKV2_AWS_51/29` (API) | Sin caché por datos sensibles; X-Ray en etapa de observabilidad; mTLS no aplica; WAF asociado con `WebACLAssociation`                                     |
| `CKV2_AWS_31` (WAF)                                 | Logs de WAF fuera de la etapa 1 por costo (decisión 8)                                                                                                    |
| `CKV_AWS_18/144/145`, `CKV2_AWS_62` (S3)            | Logs de acceso y replicación fuera del MVP; frontend con SSE-S3 (decisión 3)                                                                              |
| `CKV_AWS_68/86/174/310/374` (CloudFront)            | Sin WAF ni dominio propio en CloudFront (decisión 9); logs fuera de la etapa 1                                                                            |
| `CKV_AWS_28` (tablas efímeras)                      | `PinChallenges` y `AccessSessions` no se restauran; PITR no aporta valor                                                                                  |
| `CKV2_AWS_57` (secretos)                            | La rotación de peppers invalida HMAC almacenados ([ADR-0009](../docs/adr/0009-kms-y-secretos.md))                                                         |

## Limitaciones conocidas

- `AWS::ApiGateway::Account` es un ajuste único por cuenta y región; el parámetro `ManageApiGatewayAccountRole` (por defecto `false`) solo debe activarse si la cuenta no tiene ya un rol de CloudWatch para API Gateway. Sin ese rol, el stage con access logs no se puede crear.
- `AuditLog` es append-only a nivel de aplicación y permisos: la política de recurso niega mutaciones a todos, pero un administrador con privilegios puede cambiarla ([ADR-0004](../docs/adr/0004-auditlog-append-only.md)). `PutItem` podría sobrescribir un evento; la aplicación usará `attribute_not_exists(pk)` con `eventId` único.
- La llave de documentos niega `kms:Decrypt` a cualquier principal distinto del rol de descarga, incluido el personal administrador; subir archivos multiparte requeriría ampliar esta política.
- WAF tiene costo adicional aproximado (unos USD 11 al mes fijos por entorno con WAF, más USD 0.60 por millón de solicitudes; depende de región, reglas y volumen).
- `prod` usa `SmsProvider=sns` solo como valor de configuración: no existe integración SNS ni permisos `sns:*`.
- El prefijo de dominio de Cognito debe ser único globalmente; los valores de `samconfig.toml` son provisionales.
