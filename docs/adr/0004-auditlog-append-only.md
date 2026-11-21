# ADR-0004: AuditLog append-only — alcance y límites

- Estado: Aceptada

## Decisión

`AuditLog` es **append-only a nivel de aplicación y de permisos IAM**:

- **Aplicación:** el código solo expone una operación de escritura (`append`), implementada con `PutItem` y la condición `attribute_not_exists(pk)`; no puede sobrescribir eventos existentes. No existe código de actualización ni de borrado.
- **Permisos:** los roles de las Lambdas solo tienen `dynamodb:PutItem` sobre la tabla; el rol de consulta administrativa solo tiene `dynamodb:Query`. Ningún rol de la aplicación tiene `UpdateItem`, `DeleteItem`, `BatchWriteItem` ni `PartiQL*` sobre `AuditLog`.
- **Contenido:** los eventos no incluyen PIN, token, nombre, fecha de nacimiento, folio ni teléfono; solo identificadores, tipo de evento, resultado, `requestId` y hashes.

## Límites (lo que esta decisión NO garantiza)

`AuditLog` **no es inmutable** ante un principal de AWS con privilegios suficientes. Por ejemplo, un administrador de la cuenta con permisos de DynamoDB, de IAM o de KMS puede:

- borrar o modificar ítems, o eliminar la tabla completa;
- modificar las políticas IAM de los roles de la aplicación;
- deshabilitar la CMK o programar su eliminación, lo que deja los datos ilegibles;
- restaurar la tabla desde PITR a un punto anterior.

## Mitigaciones previstas (no incluidas en el MVP salvo que se apruebe)

- AWS CloudTrail con data events de DynamoDB para detectar operaciones fuera de la aplicación.
- Exportación periódica a un bucket S3 con **Object Lock** en modo compliance.
- SCPs de AWS Organizations que nieguen `DeleteItem`/`UpdateItem`/`DeleteTable` sobre `AuditLog` excepto a un rol de emergencia.
- `DeletionProtectionEnabled` en la tabla (incluido en `prod`).

## Consecuencias

La auditoría sirve para trazabilidad operativa y detección de abuso del flujo. No es evidencia a prueba de manipulación ante administradores de la cuenta mientras no se adopten las mitigaciones anteriores.
