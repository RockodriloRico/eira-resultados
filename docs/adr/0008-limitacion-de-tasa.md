# ADR-0008: Limitación de tasa — API Gateway, AWS WAF y límite por paciente

- Estado: Propuesta (pendiente de aprobación; se implementa en la etapa 1)

## Contexto

El throttling de API Gateway es agregado para todas las clientas: protege la capacidad y el costo, pero no limita a un atacante concreto. La limitación por IP requiere AWS WAF. La fuerza bruta distribuida contra un expediente se mitiga con un límite por paciente.

## Decisión

- **API Gateway:** throttling por método siempre activo (valores en [security-design.md §1.1](../security-design.md#11-throttling-de-api-gateway-siempre-activo)).
- **AWS WAF incluido en la plantilla SAM:**
  - Web ACL regional asociada al stage, con reglas administradas (reputación de IP, entradas maliciosas conocidas, conjunto común) y reglas rate-based por IP con scope-down a `/v1/access/*`.
  - Parámetro `EnableWaf` (por defecto `true`) y `Rule` que impide `EnableWaf=false` en `prod`.
- **Límite por paciente:** contador con ventana de 1 hora en el ítem de `Patients`, con actualizaciones condicionales atómicas. Al alcanzarlo, la respuesta es la misma que la de un señuelo (sin `429`, para no revelar existencia).
- **Sin tabla `RateLimits`.**

## Consecuencias

- Si `EnableWaf=false` (solo `dev`/`demo`), no hay limitación por IP en ese entorno. Queda documentado como limitación conocida del MVP.
- WAF agrega costo fijo mensual por Web ACL y por regla, más costo por solicitudes.
- Los umbrales por IP deben ser conservadores por el CGNAT de redes móviles y se calibrarán con las métricas de WAF.
- La detección rate-based de WAF tiene retraso (normalmente < 30 s según AWS) y su límite es aproximado; por eso el límite por paciente es el control determinista.
