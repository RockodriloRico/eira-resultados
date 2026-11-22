# ADR-0009: Dos llaves KMS y secretos generados por CloudFormation

Estado: **Aceptada** (etapa 1).

## Contexto

Los datos de pacientes (DynamoDB), los secretos HMAC y los logs tienen consumidores distintos a los documentos de resultados en S3. Con una sola llave, cualquier rol que necesite leer DynamoDB tendría permisos KMS sobre la misma llave que protege los documentos.

## Decisión

- **`DataKey`**: cifra las cinco tablas, los dos secretos de Secrets Manager y los log groups. Los roles la usan solo con `kms:ViaService` de DynamoDB o Secrets Manager; el servicio de logs, solo para log groups `eira-${Stage}-*`.
- **`DocumentsKey`**: solo cifra el bucket de documentos. Su política de llave **niega** `kms:Decrypt` a todo principal excepto `eira-${Stage}-download-url` y `kms:GenerateDataKey*` a todo principal excepto `eira-${Stage}-admin-results`. La política del bucket exige SSE-KMS con esta llave.
- Ambas llaves tienen rotación automática y `DeletionPolicy: Retain`.
- `IdentityHmacSecret` (pepper de folio, nombre, fecha, IP y user agent) y `PinHmacSecret` los genera CloudFormation con `GenerateSecretString`; su valor nunca existe en el repositorio, en `samconfig.toml` ni en los outputs.
- La rotación automática de secretos no se configura: rotar el pepper de identidad invalida todos los HMAC almacenados y exige un proceso de re-cálculo. La rotación del secreto del PIN se decidirá con la lógica del PIN (etapa 2).

## Consecuencias

- Costo aproximado de USD 1 al mes por llave adicional, más solicitudes.
- Nadie, salvo el rol de descarga, puede descifrar documentos por API, incluido el personal con acceso a la consola, mientras no cambie la política de la llave (un administrador de la cuenta sí puede cambiarla).
- Subidas multiparte de documentos requerirían permitir `kms:Decrypt` también al rol administrativo de resultados.
