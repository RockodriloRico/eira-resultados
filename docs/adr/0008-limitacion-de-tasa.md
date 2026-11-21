# ADR-0008: Limitación de tasa — API Gateway, AWS WAF y límite por paciente

- Estado: Propuesta (pendiente de aprobación; se implementa en la etapa 1)

## Contexto

El throttling de API Gateway es agregado para todas las clientas: protege la capacidad y el costo, pero no limita a un atacante concreto. La limitación por IP requiere AWS WAF. La fuerza bruta distribuida contra un expediente se mitiga con un límite por paciente.

## Decisión

- **API Gateway:** throttling por método siempre activo (valores en [security-design.md §1.1](../security-design.md#11-throttling-de-api-gateway-siempre-activo)).
- **AWS WAF incluido en la plantilla SAM:**
  - Web ACL regional asociada al stage, con reglas administradas (reputación de IP, entradas maliciosas conocidas, conjunto común) y reglas rate-based por IP con scope-down a `/v1/access/*`.
  - Parámetro `EnableWaf` (por defecto `true`).
  - En `prod` no se puede desactivar, por capas de infraestructura (no son reglas de WAF):
    - `AllowedValues` en los parámetros;
    - aserción `Rules` de CloudFormation (`Stage=prod` exige `EnableWaf=true`), que falla antes de tocar recursos;
    - `Condition` `CreateWaf` que crea WAF en `prod` sin importar el parámetro;
    - pruebas de plantilla en CI;
    - en el futuro, regla de AWS Config `api-gw-associated-with-waf` y SCP opcional.
    - Detalle en [security-design.md §1.2.1](../security-design.md#121-cómo-se-impide-enablewaffalse-en-producción).
- **Límite por paciente:** 5 SMS por ventana fija de 1 hora, con un único contador para solicitudes y reenvíos en el ítem de `Patients`.
  - El contador y el reto se escriben en una sola `TransactWriteItems` con condiciones, así que no se puede superar el límite bajo concurrencia.
  - La ventana se reinicia de forma perezosa en la primera emisión después de 3600 s.
  - Al alcanzarlo, la respuesta es la misma que la de un señuelo (sin `429`, para no revelar existencia).
  - Detalle en [security-design.md §1.3](../security-design.md#13-límite-por-paciente-sin-tabla-adicional).
- **Sin tabla `RateLimits`.**

## Consecuencias

- Si `EnableWaf=false` (solo `dev`/`demo`), no hay limitación por IP en ese entorno. Queda documentado como limitación conocida del MVP.
- **Alcance:** WAF y su asociación con API Gateway son infraestructura futura (etapa 1); nada está desplegado.
- **Costo:** WAF agrega costo. Con precios de lista: USD 5 / mes por Web ACL + USD 1 / mes por regla o grupo + USD 0.60 por millón de solicitudes. Son ≈ USD 11 / mes fijos por entorno con la configuración propuesta, sin contar logs.
- Los umbrales por IP deben ser conservadores por el CGNAT de redes móviles y se calibrarán con las métricas de WAF.
- La detección rate-based de WAF tiene retraso (normalmente < 30 s según AWS) y su límite es aproximado; por eso el límite por paciente es el control determinista.
