# Modelo de datos y patrones de acceso

Principio: **cada tabla existe porque tiene un patrón de acceso, un ciclo de vida o una frontera de permisos distinta.** Todo lo que no cumple esto se elimina del MVP.

## Patrones de acceso del MVP

| #   | Patrón                                                                                 | Quién                             | Operación                                        |
| --- | -------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------ |
| AP1 | Buscar expediente por folio (vía `folioHash`) y verificar nombre y fecha (HMAC)        | Lambda de solicitud de acceso     | `Query` GSI `FolioHashIndex`                     |
| AP2 | Limitar solicitudes de PIN por paciente y ventana de tiempo                            | Lambda de solicitud de acceso     | `UpdateItem` condicional sobre el expediente     |
| AP3 | Crear reto PIN; leerlo y actualizarlo por `challengeId` (intentos, reenvío, uso único) | Solicitud, reenvío y verificación | `PutItem` / `GetItem` / `UpdateItem` condicional |
| AP4 | Crear sesión; validarla en cada petición por hash del token; revocarla                 | Verificación, authorizer, logout  | `PutItem` / `GetItem` / `UpdateItem`             |
| AP5 | Listar resultados de la paciente de la sesión                                          | Lambda de listado                 | `Query` GSI `PatientIndex`                       |
| AP6 | Obtener un resultado por `resultId` y comprobar que pertenece a la paciente            | Lambda de URL firmada             | `GetItem`                                        |
| AP7 | Registrar evento de auditoría                                                          | Todas las Lambdas                 | `PutItem` con `attribute_not_exists`             |
| AP8 | Consultar auditoría por paciente o tipo de evento y rango de fechas                    | Admin                             | `Query` (tabla y GSI)                            |
| AP9 | Alta de expediente y de resultado (sintéticos)                                         | Admin                             | `PutItem`                                        |

## Tablas: de seis a cinco

La propuesta inicial tenía seis tablas. Al revisarla contra los patrones de acceso, **`RateLimits` no aporta valor suficiente al MVP** y se elimina:

- **Límite por IP:** lo cubren las reglas rate-based de AWS WAF, incluidas en la plantilla y obligatorias en `prod`. El throttling de API Gateway limita el volumen agregado, no por IP. Ninguno requiere estado propio ([security-design.md §1](security-design.md#1-limitación-de-tasa), [ADR-0008](adr/0008-limitacion-de-tasa.md)).
- **Límite por paciente (AP2):** se guarda en el propio ítem de `Patients` (`pinRequestCount`, `pinWindowStartsAt`) con una actualización condicional atómica. La Lambda solo puede escribir esos atributos (condición IAM `dynamodb:Attributes`). Expresiones exactas en [security-design.md §1.3](security-design.md#13-límite-por-paciente-sin-tabla-adicional).
- **Retos señuelo** (datos no coincidentes): no envían SMS y caducan solos, así que el throttling de API Gateway es suficiente.

### Tablas resultantes

| Tabla            | Clave                                  | Patrones      | Por qué es una tabla separada                                                                                                                                                                     |
| ---------------- | -------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Patients`       | PK `patientId`; GSI `FolioHashIndex`   | AP1, AP2, AP9 | Contiene datos personales (teléfono). Solo la leen las Lambdas de acceso y de admin; las Lambdas de resultados y de descarga **no** tienen permiso sobre ella                                     |
| `PinChallenges`  | PK `challengeId`; TTL                  | AP3           | Datos efímeros (5 min) con alta tasa de escrituras condicionales. El TTL limpia automáticamente. El authorizer no necesita acceso                                                                 |
| `AccessSessions` | PK `tokenHash`; TTL                    | AP4           | Se lee en **cada** petición autenticada. El Lambda authorizer solo tiene `GetItem` sobre esta tabla y no puede leer PINs ni expedientes                                                           |
| `Results`        | PK `resultId`; GSI `PatientIndex`      | AP5, AP6, AP9 | Solo metadatos (sin contenido clínico) y referencia a S3. La Lambda de descarga lee aquí sin acceder a datos personales de `Patients`                                                             |
| `AuditLog`       | PK `pk`, SK `sk`; GSI `EventTypeIndex` | AP7, AP8      | Retención larga y permisos distintos: solo `PutItem` para las Lambdas y `Query` para admin. Nadie en la aplicación tiene `UpdateItem`/`DeleteItem` ([ADR-0004](adr/0004-auditlog-append-only.md)) |

### Por qué no single-table design

- Con una sola tabla, el control de acceso por entidad dependería de condiciones `dynamodb:LeadingKeys` sobre prefijos. Funciona, pero es más difícil de revisar y de probar.
- Los ciclos de vida difieren (TTL de minutos frente a retención larga de auditoría), igual que las necesidades de PITR y los permisos.
- El volumen del MVP es bajo; cinco tablas on-demand no tienen costo fijo relevante.

### Por qué no menos tablas

| Fusión posible                     | Motivo para no hacerla                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| `PinChallenges` + `AccessSessions` | El authorizer, que corre en cada petición, tendría acceso de lectura a los retos PIN |
| `Patients` + `Results`             | La Lambda de descarga podría leer teléfonos y hashes de identidad                    |
| `AuditLog` dentro de otra tabla    | Se pierde la garantía append-only por permisos                                       |

## Controles comunes

- Cifrado con CMK de KMS, PITR (excepto en tablas solo con datos efímeros, donde aporta poco), modo on-demand y `DeletionProtection` en `prod`.
- Nunca se guardan en claro: PIN, token de sesión, folio, nombre ni fecha de nacimiento (solo HMAC). El teléfono es necesario para el SMS y se protege con el cifrado de la tabla y con IAM.

## Atributos relevantes para los controles

| Tabla            | Atributos                                                                                                                                                  | Uso                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `Patients`       | `folioHash`, `nameHash`, `birthDateHash`, `status`, `dataClassification` (`SYNTHETIC` obligatorio en `demo`), `pinWindowStartsAt`, `pinRequestCount`       | Verificación, límite por paciente, guarda de `demoPin` |
| `PinChallenges`  | `challengeId`, `kind` (`REAL`/`DECOY`), `patientId` (solo `REAL`), `pinHmac`, `attempts`, `resendCount`, `status`, `expiresAt`, `resendAvailableAt`, `ttl` | Reto, señuelos, expiración y concurrencia              |
| `AccessSessions` | `tokenHash`, `patientId`, `expiresAt`, `revoked`, `ttl`                                                                                                    | Sesión opaca revocable                                 |

`expiresAt` es la fuente de verdad de la expiración y `ttl` solo sirve de limpieza ([security-design.md §3](security-design.md#3-expiración)).

## AuditLog: claves, índices y consultas

### Claves

| Atributo             | Valor                                                                                                                                                                                                                                     | Propósito                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `pk` (partition key) | `PATIENT#{patientId}` si el evento se relaciona con un expediente conocido (incluidas las acciones administrativas sobre ese expediente); `ANON#{YYYY-MM-DD}` para eventos sin expediente asociado (datos no coincidentes, retos señuelo) | Consulta por paciente                         |
| `sk` (sort key)      | `{occurredAt ISO-8601 UTC}#{eventId}` (`eventId` = UUID v4)                                                                                                                                                                               | Orden cronológico, rangos de fecha y unicidad |
| `eventType`          | p. ej. `PIN_VERIFY_FAIL`                                                                                                                                                                                                                  | Partition key del GSI                         |

**GSI `EventTypeIndex`**: partition key `eventType`, sort key `sk`, proyección `ALL`.

### Consultas (AP8)

| Consulta                            | Operación                                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------------- |
| Eventos de una paciente en un rango | `Query` tabla: `pk = :PATIENT#id AND sk BETWEEN :desde AND :hasta`, `ScanIndexForward=false` |
| Eventos de un tipo en un rango      | `Query` `EventTypeIndex`: `eventType = :tipo AND sk BETWEEN :desde AND :hasta`               |
| Eventos sin expediente de un día    | `Query` tabla: `pk = :ANON#fecha`                                                            |

- La API admin (`GET /v1/admin/audit?patientId=…|eventType=…&from=…&to=…`) exige exactamente un filtro, un rango máximo de 31 días y un límite de 100 por página. La paginación usa un cursor opaco derivado de `LastEvaluatedKey`.
- No hay `Scan`.
- Volumen del MVP: una partición por `eventType` es suficiente. Si creciera, el GSI puede particionarse como `eventType#YYYY-MM` sin cambiar la tabla base.
- La consulta por administrador (`actorId`) queda fuera del MVP; se agregaría como GSI si se requiere.

### Atributos de cada evento

`eventId`, `eventType`, `outcome` (`SUCCESS`/`FAILURE`), `reasonCode` (p. ej. `EXPIRED`, `LOCKED`, `MISMATCH`, `RATE_LIMITED`), `occurredAt`, `actorType` (`PATIENT`/`ADMIN`/`SYSTEM`), `actorId` (`sub` de Cognito para admin; vacío para paciente), `patientId?`, `challengeId?`, `resultId?`, `requestId` (API Gateway), `sourceIpHash` y `userAgentHash` (HMAC con pepper).

**Nunca:** PIN, `demoPin`, token, nombre, fecha de nacimiento, folio ni teléfono.

### Escritura

- `PutItem` con `attribute_not_exists(pk)`: append-only, ver [ADR-0004](adr/0004-auditlog-append-only.md).
- **Fail-closed en eventos que conceden acceso:** `SESSION_CREATED` se escribe dentro de la misma transacción que consume el PIN, y `DOWNLOAD_URL_ISSUED` se escribe antes de firmar la URL. Si falla, no se concede el acceso.
- Los eventos de fallo se escriben en modo best-effort, con métrica `AuditWriteFailed` y alarma.
- Retención: sin TTL en el MVP; la política de retención la definirá EIRA.
