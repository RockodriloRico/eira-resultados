# ADR-0003: Política de `demoPin`

- Estado: Aceptada (revisada para evitar enumeración)

## Contexto

La demostración usa `MockSmsProvider`, que no envía SMS. Para probar el flujo, la persona que hace la demo necesita ver el PIN. Exponerlo no debe permitir enumerar expedientes, no debe filtrarse a producción y solo debe usarse con datos sintéticos.

## Decisión

1. **Condiciones de exposición** (todas obligatorias):
   - parámetro `Stage=demo`;
   - parámetro `SmsProvider=mock`;
   - verificación **en tiempo de ejecución** de que la instancia activa de `SmsProvider` es `MockSmsProvider` (sobre la instancia, no solo sobre una variable de entorno).
2. **Misma forma de respuesta:** cuando se cumplen las condiciones, **todas** las respuestas `202` de `request` y `resend` incluyen `demoPin`, tanto para retos reales como para señuelos. En un señuelo es un PIN aleatorio que nunca valida. La presencia del campo no depende de la existencia del expediente.
3. **Guarda de datos sintéticos:**
   - En `demo`, el alta administrativa y el seed fuerzan `dataClassification = SYNTHETIC`.
   - Un expediente sin esa marca se trata como señuelo (respuesta idéntica, sin sesión posible) y dispara la alarma `NonSyntheticRecordInDemo`.
4. **Aislamiento:** `demo` es un stack independiente con tablas, bucket, CMK y secretos propios. Se recomienda una cuenta AWS separada.
5. **Nunca persistido ni registrado:**
   - Solo se guarda `pinHmac`.
   - El logger redacta `pin`/`demoPin` y no se registran cuerpos de respuesta.
   - API Gateway usa `DataTraceEnabled: false`.
   - Una prueba busca el PIN en toda la salida capturada.
6. **Producción:**
   - `Rule` de CloudFormation que falla con `Stage=prod` y `SmsProvider=mock`.
   - El código rechaza arrancar en esa combinación.
   - El esquema de respuesta de `prod` no contiene `demoPin` (prueba de contrato).

## Límite aceptado

`demoPin` elimina el factor de posesión (el teléfono). En `demo`, quien conozca nombre, fecha y folio de un expediente sintético puede autenticarse, y por tanto distinguir en `verify` si existe. Este riesgo solo es aceptable porque `demo` contiene exclusivamente datos sintéticos y está aislado de `prod`.

Detalle operativo en [security-design.md §4](../security-design.md#4-demopin).
