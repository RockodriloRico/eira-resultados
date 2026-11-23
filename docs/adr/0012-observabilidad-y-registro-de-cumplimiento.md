# ADR-0012: Observabilidad, alarmas y registro de cumplimiento

- Estado: Aceptada (etapa 3, decisiones 3 y 6)

## Decisión

- **Alarmas en todos los entornos** (CloudWatch, nombres `eira-<stage>-*`):
  - Errores por cada una de las 11 Lambdas y throttling de Lambda.
  - API Gateway: 5XX, pico de 4XX y latencia p99 > 3 s.
  - Throttling de las 5 tablas DynamoDB (una alarma con _metric math_).
  - WAF: pico de solicitudes bloqueadas (si existe el Web ACL).
  - Métricas de aplicación: fallo de auditoría, fallo de SMS, registro no sintético en `demo`, piso anti-enumeración excedido, retos de PIN bloqueados, descargas denegadas y acceso administrativo sin el grupo `admins`.
- **Métricas de aplicación** en EMF (`EiraResultados`, dimensión `Stage`), con una lista cerrada de nombres (`METRIC_NAMES`) y solo conteos. Nunca incluyen identificadores ni datos personales.
- **SNS solo para alarmas.** El tema `eira-<stage>-ops-alarms` está cifrado con una tercera CMK, `OpsKey`, separada de `DataKey` y `DocumentsKey`.
  - Solo CloudWatch puede publicar, y solo desde alarmas `eira-<stage>-*`. Cualquier otro principal, incluidos los usuarios IAM, tiene la publicación denegada.
  - La plantilla **no crea suscripciones**. Solo se permiten suscripciones `email`, y se crean a mano tras una autorización expresa.
  - Los mensajes son los estándar de CloudWatch: nombre, métrica y umbral, sin datos de pacientes.
- **Dashboard** `eira-<stage>-operacion` con API, Lambda, DynamoDB, WAF y métricas de aplicación.
- **Registro de cumplimiento con parámetros**, desactivado por defecto. Una Rule lo rechaza fuera de `prod`, y las Conditions exigen `prod` además del parámetro:

| Parámetro                    | Recursos                                                                           | Cifrado                                | Retención                    | Permisos                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| `EnableWafLogs`              | Log group `aws-waf-logs-eira-prod` y `LoggingConfiguration`                        | `OpsKey`                               | 90 días                      | Entrega de WAF. Solo se guardan BLOCK y COUNT. Se redactan `authorization`, `cookie` y la query string |
| `EnableS3AccessLogs`         | `AccessLogsBucket` y logging de los buckets de documentos y frontend               | SSE-S3 (S3 no admite KMS como destino) | 365 días                     | Solo `logging.s3.amazonaws.com`, con `SourceArn` de los dos buckets                                    |
| `EnableCloudTrailDataEvents` | Trail `eira-prod-data-events` y `ComplianceLogsBucket`                             | `OpsKey`                               | 400 días                     | CloudTrail, con `SourceArn` del trail. Validación de integridad activa                                 |
| `EnableAwsConfig`            | Grabador de 10 tipos de recurso, diario; canal de entrega y 4 reglas administradas | `OpsKey`                               | 400 días (bucket compartido) | Rol `config.amazonaws.com` con `AWS_ConfigRole` y escritura en `config/`                               |

## Consecuencias

- Los logs de WAF contienen la IP y la ruta de solicitudes bloqueadas. La IP puede ser un dato personal: acceso restringido y retención de 90 días.
- AWS Config admite **un grabador por cuenta y región**. Si la cuenta ya tiene uno, no se activa `EnableAwsConfig`.
- El trail no incluye eventos de gestión, que normalmente cubre el trail de la cuenta. Verificarlo antes de `prod`.
- `aws:PrincipalServiceName` en la política del tema debe confirmarse con una alarma de prueba en `demo`, después del primer despliegue autorizado (runbook).
- Costos: [observability.md](../observability.md).
