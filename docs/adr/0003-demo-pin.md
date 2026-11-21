# ADR-0003: Política de `demoPin`

- Estado: Aceptada

## Contexto

La demostración usa `MockSmsProvider`, que no envía SMS. Para probar el flujo, la persona que hace la demo necesita ver el PIN.

## Decisión

La respuesta de `POST /v1/access/request` incluye `demoPin` **solo si se cumplen todas estas condiciones**:

1. El parámetro de la plantilla es `Stage=demo`.
2. El backend confirma **en tiempo de ejecución** que la instancia activa de `SmsProvider` es `MockSmsProvider` (verificación sobre la instancia, no solo sobre una variable de entorno).
3. La solicitud corresponde a un expediente verificado. Los retos señuelo no devuelven `demoPin`; se documentará que esto revela la coincidencia y por eso solo se permite en `demo`.

Además:

- `demoPin` **nunca** se guarda en DynamoDB (solo `pinHmac`) ni aparece en logs. El logger redacta el campo y una prueba automatizada busca el PIN en toda la salida capturada.
- La plantilla SAM incluye una `Rule` que hace fallar la plantilla con `Stage=prod` y `SmsProvider=mock`. Por defensa en profundidad, el código también rechaza arrancar en esa combinación.

## Consecuencias

- El entorno `demo` es explícitamente menos seguro que `prod` y solo debe usarse con datos sintéticos.
