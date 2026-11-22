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
