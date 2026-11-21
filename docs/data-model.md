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

- **Límite por IP:** lo cubren el throttling por método de API Gateway y, opcionalmente, una regla rate-based de AWS WAF. No requiere estado propio.
- **Límite por paciente (AP2):** se guarda en el propio ítem de `Patients` (`pinRequestCount`, `pinWindowStartsAt`) con una actualización condicional atómica. La Lambda solo puede escribir esos atributos (condición IAM `dynamodb:Attributes`).
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

El detalle de atributos se define en la etapa 1 junto con `template.yaml`.
