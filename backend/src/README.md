# backend/src

| Carpeta / archivo | Contenido                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| `config.ts`       | Configuración por variables de entorno; `demoPin` solo con `Stage=demo` y `SmsProvider=mock`        |
| `security/`       | `node:crypto` (aleatoriedad, HMAC, comparación en tiempo constante) y proveedores de secretos       |
| `domain/`         | Normalización de identidad y HMAC por campo                                                         |
| `sms/`            | `SmsProvider`, `MockSmsProvider`, `AwsSnsSmsProvider` (stub que falla) y el texto del SMS           |
| `repositories/`   | Acceso a las cinco tablas; `AuditRepository` escribe con `attribute_not_exists(pk)`                 |
| `services/`       | Reglas de negocio de pacientes y resultados (máquina de estados)                                    |
| `http/`           | Validación con zod, errores genéricos y respuestas `no-store`                                       |
| `observability/`  | Logger JSON con redacción y métricas EMF                                                            |
| `local/`          | Datos sintéticos y servidor local. **Nunca** se empaqueta en Lambda: el build solo toma `handlers/` |
| `handlers/`       | Entradas Lambda                                                                                     |

## Sesiones, consulta y descarga (entrega 3)

- `handlers/sessionAuthorizer.ts`: authorizer REQUEST. `Authorization: Bearer <token>` → `sha256(token)` → `GetItem` consistente en `AccessSessions`; exige `expiresAt > now` y `revoked != true`. El contexto lleva solo `patientId` y `tokenHash`.
- `services/patientResultsService.ts`: el listado usa solo `PatientIndex` (sin `s3Key`) y filtra `APPROVED`. La descarga verifica dueño y estado, escribe `DOWNLOAD_URL_ISSUED` **antes** de firmar (si falla, no hay URL) y firma por 60 s. Inexistente, ajeno o no aprobado responden el mismo `404` y quedan como `DOWNLOAD_DENIED`.
- `storage/DocumentStorage.ts`: `S3DocumentStorage` (URL firmada SigV4) y `LocalDocumentStorage`, que imita la firma (clave + expiración + HMAC) para el servidor local. Las claves se validan contra `results/pat_…/res_…/vN.pdf`.
- `local/syntheticPdf.ts`: PDF con la leyenda "DOCUMENTO SINTETICO - SIN VALOR CLINICO"; el seed lo genera al ejecutar, no se guarda en el repositorio.

## Operaciones administrativas (entrega 4)

- Identidad: `sub` de Cognito (`requestContext.authorizer.claims`); sin claims, `401`. Sin el grupo
  `admins` en `cognito:groups`, `403`.
- `adminPatients`: alta, búsqueda exacta por folio y consulta. La lectura se limita a `patientId, status, dataClassification, phoneE164, createdAt`; el teléfono se devuelve enmascarado.
- `adminResults`: alta de resultado, listado por expediente, URL de carga, confirmación (`submit`) y revisión. La URL de carga firma tamaño, `x-amz-checksum-sha256` y SSE-KMS: S3 rechaza otro archivo. `submit` compara con `HeadObject` antes de pasar a `PENDING_REVIEW`. Cada corrección crea una versión nueva (`vN.pdf`).
- `adminReviewUrl`: función y rol propios; URL de 60 s solo en `PENDING_REVIEW` (ADR-0009, enmienda).
- `adminAudit`: consulta por expediente o tipo de evento (máx. 31 días) y registra `AUDIT_QUERIED`.
