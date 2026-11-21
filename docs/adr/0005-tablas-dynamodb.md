# ADR-0005: Tablas DynamoDB según patrones de acceso

- Estado: Aceptada conceptualmente (detalle de atributos en la etapa 1)

## Decisión

Usar **cinco** tablas: `Patients`, `PinChallenges`, `AccessSessions`, `Results` y `AuditLog`. Se elimina `RateLimits` de la propuesta original:

- El límite por IP lo hacen las reglas rate-based de AWS WAF (obligatorias en `prod`, ver [ADR-0008](0008-limitacion-de-tasa.md)); el throttling de API Gateway limita el volumen agregado.
- El límite por paciente se guarda como contador en el ítem de `Patients`, con actualización condicional.

La justificación completa por patrón de acceso está en [data-model.md](../data-model.md).

## Consecuencias

- Cada tabla corresponde a una frontera de permisos IAM distinta, lo que facilita aplicar y probar el mínimo privilegio.
- Una tabla menos que mantener, sin perder controles en el MVP.
