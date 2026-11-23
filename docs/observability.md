# Observabilidad y registro de cumplimiento

Decisión en [ADR-0012](adr/0012-observabilidad-y-registro-de-cumplimiento.md). Esta etapa no despliega nada: todo se valida localmente (`npm run check`, `sam validate --lint`, cfn-lint, Checkov).

## Métricas de aplicación

Namespace `EiraResultados`, dimensión única `Stage`, unidad `Count`. Los nombres están en `METRIC_NAMES` (`backend/src/observability/logger.ts`); una prueba comprueba que cada evento EMF contiene solo `_aws`, `Stage` y el conteo.

| Métrica                    | Origen                                                 | Alarma (5 min)       |
| -------------------------- | ------------------------------------------------------ | -------------------- |
| `AuditWriteFailed`         | Repositorio de auditoría                               | ≥ 1                  |
| `SmsSendFailed`            | Envío de PIN                                           | ≥ 1                  |
| `NonSyntheticRecordInDemo` | Alta en `demo` sin clasificación sintética             | ≥ 1                  |
| `ResponseFloorExceeded`    | Respuesta más lenta que el piso de 1000 ms + jitter    | ≥ 10                 |
| `PinVerifyFailed`          | Verificación de PIN fallida                            | Solo en el dashboard |
| `PinChallengeLocked`       | Reto bloqueado tras 5 intentos                         | ≥ 20                 |
| `DownloadDenied`           | Descarga de resultado inexistente, ajeno o no aprobado | ≥ 20                 |
| `AdminForbidden`           | Token de Cognito sin el grupo `admins`                 | ≥ 1                  |

## Alarmas de servicio

- **Lambda:** `Errors` ≥ 1 por función (11 alarmas) y `Throttles` ≥ 1 en la cuenta y región.
- **API Gateway:** `5XXError` ≥ 5, `4XXError` ≥ 200 durante 2 periodos, y latencia p99 > 3000 ms durante 3 periodos.
- **DynamoDB:** suma de `Read/WriteThrottleEvents` de las 5 tablas ≥ 1.
- **WAF:** `BlockedRequests` ≥ 100 (solo si existe el Web ACL).

Los umbrales son iniciales y se ajustan con tráfico real en `demo`.

## Costos estimados (us-east-1, USD al mes)

Precios públicos de AWS a la fecha de la plantilla, sin el nivel gratuito. Deben confirmarse con AWS Pricing Calculator antes de cada despliegue.

| Concepto                                                                                                        | dev      | demo     | prod (todo activado)  |
| --------------------------------------------------------------------------------------------------------------- | -------- | -------- | --------------------- |
| Alarmas estándar (~29 métricas × 0.10)                                                                          | 2.90     | 2.90     | 2.90                  |
| Dashboard (3 gratis por cuenta; después 3.00)                                                                   | 0–3      | 0–3      | 0–3                   |
| `OpsKey` (CMK)                                                                                                  | 1.00     | 1.00     | 1.00                  |
| SNS (correo, < 1000 notificaciones)                                                                             | ~0       | ~0       | ~0                    |
| Métricas EMF (8 métricas personalizadas × 0.30)                                                                 | 2.40     | 2.40     | 2.40                  |
| Logs de WAF (solo BLOCK y COUNT; 0.50/GB de ingesta)                                                            | —        | —        | < 1                   |
| Logs de acceso de S3 (almacenamiento)                                                                           | —        | —        | < 1                   |
| CloudTrail, eventos de datos (0.10 por 100 000)                                                                 | —        | —        | 1–5 con 1–5 M eventos |
| AWS Config (grabación diaria: 0.012 por elemento registrado, solo cuando cambió; 0.001 por evaluación de regla) | —        | —        | 1–3                   |
| **Total de observabilidad**                                                                                     | **~6–9** | **~6–9** | **~10–20**            |
