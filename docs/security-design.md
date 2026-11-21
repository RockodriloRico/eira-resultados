# Diseño de controles de seguridad del flujo de acceso

> Documento de diseño para la etapa 0. Los valores numéricos son la propuesta inicial; se fijan en `infrastructure/template.yaml` (etapa 1) y en `packages/shared/src/securityPolicy.ts`.

Contenido:

1. [Limitación de tasa: API Gateway, WAF y límite por paciente](#1-limitación-de-tasa)
2. [Anti-enumeración](#2-anti-enumeración)
3. [Expiración](#3-expiración)
4. [`demoPin`](#4-demopin)
5. [Concurrencia y escrituras condicionales](#5-concurrencia-y-escrituras-condicionales)
6. [Auditoría: claves e índices](data-model.md#auditlog-claves-índices-y-consultas) (en `data-model.md`)

---

## 1. Limitación de tasa

Hay tres mecanismos con propósitos distintos. Ninguno sustituye a los otros.

| Mecanismo                                       | Qué limita                                                                                                                | Granularidad                                                                                                     | Protege contra                                                                      | No protege contra                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Throttling de API Gateway** (stage/método)    | Tasa **agregada** de todas las clientas (token bucket: `rate` + `burst`)                                                  | Por método y stage. No distingue clientes, salvo con usage plans + API keys, que no aplican a pacientes anónimas | Picos de volumen, costo y saturación de Lambda/DynamoDB                             | Un atacante concreto: una sola IP puede consumir todo el presupuesto y negar el servicio a las demás                    |
| **Reglas rate-based de AWS WAF**                | Solicitudes **por IP de origen** (u otra clave de agregación) en una ventana de 60, 120, 300 o 600 s; límite mínimo de 10 | Por IP y, opcionalmente, por ruta (scope-down)                                                                   | Fuerza bruta y abuso desde una IP; IPs con mala reputación (reglas administradas)   | Ataques distribuidos en muchas IPs. La detección tiene retraso (normalmente < 30 s según AWS) y el límite es aproximado |
| **Límite por paciente** (DynamoDB, condicional) | SMS/PIN emitidos **por expediente** por hora                                                                              | Por `patientId`                                                                                                  | SMS bombing a una paciente y fuerza bruta distribuida contra un expediente concreto | Nada a nivel de red (eso lo cubren los dos anteriores)                                                                  |

### 1.1 Throttling de API Gateway (siempre activo)

Configurado con `MethodSettings` del stage (valores iniciales, agregados para todas las clientas):

| Ruta                                                    | rate (req/s) | burst |
| ------------------------------------------------------- | ------------ | ----- |
| `POST /v1/access/request`                               | 10           | 20    |
| `POST /v1/access/resend`                                | 5            | 10    |
| `POST /v1/access/verify`                                | 10           | 20    |
| `GET /v1/results`, `POST /v1/results/{id}/download-url` | 20           | 40    |
| `/v1/admin/*`                                           | 10           | 20    |
| Resto del stage (default)                               | 50           | 100   |

Las respuestas `429` de API Gateway no dependen de la existencia de un expediente.

### 1.2 AWS WAF: incluido en la plantilla SAM

**Decisión:** la plantilla de la etapa 1 incluirá `AWS::WAFv2::WebACL` (scope `REGIONAL`) y `AWS::WAFv2::WebACLAssociation` con el stage de la API REST, bajo el parámetro `EnableWaf` (por defecto `true`).

- En `dev`/`demo` puede desactivarse por costo. En ese caso **la limitación por IP no existe en ese entorno** y queda documentada como limitación conocida del MVP; siguen vigentes el throttling agregado y el límite por paciente.
- En `prod` no puede desactivarse (ver 1.2.1).
- Ver [ADR-0008](adr/0008-limitacion-de-tasa.md).

#### 1.2.1 Cómo se impide `EnableWaf=false` en producción

Son controles de **infraestructura y despliegue**, no reglas de AWS WAF: una regla de WAF filtra solicitudes HTTP y no puede impedir que el Web ACL deje de existir.

| Capa                                          | Mecanismo                                                                                                                                                                        | Cuándo actúa                                  | Qué garantiza                                                                                                            |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1. Validación de parámetros                   | `Parameters` con `AllowedValues`: `Stage` ∈ {`dev`, `demo`, `prod`}, `EnableWaf` ∈ {`true`, `false`}                                                                             | Al crear/actualizar el stack o un change set  | Rechaza valores fuera de lista. Por sí sola no puede relacionar dos parámetros                                           |
| 2. Aserción de CloudFormation                 | Sección `Rules`: regla `ProdRequiresWaf` con `RuleCondition: Stage = prod` y `Assertions: EnableWaf = true` (junto a `ProdForbidsMockSms`)                                       | Antes de crear o actualizar cualquier recurso | `Stage=prod` + `EnableWaf=false` falla la operación y no se toca ningún recurso                                          |
| 3. Condición de CloudFormation                | `Conditions: CreateWaf = Or(Equals(Stage, prod), Equals(EnableWaf, true))`, aplicada a `WebACL` y `WebACLAssociation`                                                            | Al evaluar la plantilla                       | En `prod` los recursos WAF se crean **aunque** el parámetro cambiara, incluso si alguien eliminara la regla de la capa 2 |
| 4. Política de despliegue (futura)            | `samconfig.toml` del entorno `prod` sin override de `EnableWaf`; en CI, `cfn-lint`, checkov y una prueba de plantilla que verifique las capas 2 y 3                              | En cada PR                                    | Un cambio que debilite la plantilla no pasa revisión                                                                     |
| 5. Detección (futura, en la cuenta de `prod`) | Regla administrada de AWS Config `api-gw-associated-with-waf`, con alarma. Opcional: SCP que niegue `wafv2:DisassociateWebACL` y `wafv2:DeleteWebACL` salvo al rol de despliegue | Continua, después del despliegue              | Detecta (y con SCP, impide) desasociaciones manuales desde la consola, que CloudFormation no ve                          |

- La compatibilidad de la sección `Rules` con la transformación de SAM se verificará con `sam validate` y `cfn-lint` en la etapa 1.
- **Límite:** un administrador con privilegios suficientes puede editar la plantilla o la cuenta. Las capas 4 y 5 hacen que ese cambio sea visible y revisable, igual que en [ADR-0004](adr/0004-auditlog-append-only.md).

#### 1.2.2 Costos y alcance

- **Nada de esto está desplegado ni existe en AWS.** En la etapa 0 solo hay documentación. El Web ACL, sus reglas y la asociación con el stage de API Gateway son infraestructura **futura**: se definirán en `template.yaml` en la etapa 1 y solo se desplegarán con aprobación explícita.
- **AWS WAF tiene costo adicional** al de API Gateway. Precios de lista publicados por AWS al redactar este documento. Son **aproximados**: dependen de la región, del número de reglas y grupos, del volumen de solicitudes y de los cambios de precio de AWS. Se recalcularán con AWS Pricing Calculator para `us-east-1` antes de desplegar.

| Concepto                   | Precio de lista         | Propuesta (1 Web ACL, 3 grupos administrados, 3 reglas rate-based) |
| -------------------------- | ----------------------- | ------------------------------------------------------------------ |
| Web ACL                    | USD 5.00 / mes          | USD 5.00 / mes                                                     |
| Regla o grupo de reglas    | USD 1.00 / mes cada uno | 6 × USD 1.00 = USD 6.00 / mes                                      |
| Solicitudes inspeccionadas | USD 0.60 / millón       | Variable                                                           |

- Costo fijo **aproximado**: **≈ USD 11 / mes por entorno con WAF**, más el costo variable por solicitudes. No incluye logs de WAF (CloudWatch Logs se cobra aparte) ni grupos de pago como Bot Control, que no se proponen.
- Por eso `EnableWaf` existe: `dev`/`demo` pueden omitir WAF para ahorrar costo, con la limitación documentada en 1.2.

Reglas propuestas (en orden de prioridad):

| #   | Regla                                                                                  | Tipo                           | Acción                                  |
| --- | -------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------- |
| 1   | `AWSManagedRulesAmazonIpReputationList`                                                | Administrada                   | Block                                   |
| 2   | `AWSManagedRulesKnownBadInputsRuleSet`                                                 | Administrada                   | Block                                   |
| 3   | `AWSManagedRulesCommonRuleSet`                                                         | Administrada                   | Block (Count en `dev` para calibrar)    |
| 4   | `AccessRequestPerIp`: rutas que terminan en `/v1/access/request` o `/v1/access/resend` | Rate-based por IP, 20 / 300 s  | Block con respuesta `429` personalizada |
| 5   | `AccessVerifyPerIp`: ruta que termina en `/v1/access/verify`                           | Rate-based por IP, 30 / 300 s  | Block `429`                             |
| 6   | `GlobalPerIp`: todo                                                                    | Rate-based por IP, 500 / 300 s | Block `429`                             |

Notas:

- La coincidencia de ruta es **por sufijo**, porque el URI de una API REST incluye el nombre del stage (`/demo/v1/access/request`).
- La API se invoca directamente en su endpoint regional (no detrás de CloudFront), así que la agregación usa la IP de origen y no `X-Forwarded-For`, que el cliente podría falsificar.
- Las redes móviles con CGNAT comparten IP entre muchas personas, por eso los umbrales son conservadores y se ajustarán con las métricas de WAF en CloudWatch.
- Los logs de WAF (si se habilitan) registran solicitudes, no respuestas, y redactan el cuerpo.

### 1.3 Límite por paciente (sin tabla adicional)

Límite inicial: **5 SMS por paciente por hora**, sumando solicitudes (`request`) y reenvíos (`resend`) en un **único contador**. Atributos en el ítem de `Patients`:

- `pinWindowStartsAt` (epoch s): inicio de la ventana vigente.
- `pinRequestCount` (N): emisiones dentro de esa ventana.

#### Ventana horaria y reinicio

- **El MVP usa ventanas fijas, no una ventana deslizante estricta.** Cada ventana dura 3600 s, empieza con la primera emisión y termina en `pinWindowStartsAt + 3600`.
- **Reinicio perezoso:** no hay tarea programada ni TTL. La primera emisión con `now >= pinWindowStartsAt + 3600` abre una ventana nueva (`pinWindowStartsAt = now`, `pinRequestCount = 1`). Si no llegan más solicitudes, los atributos viejos no tienen efecto.
- **Cota real:**
  - Cada ventana fija permite como máximo 5 emisiones.
  - En cualquier período móvil de 60 minutos pueden ocurrir **hasta 10 emisiones (2 × 5)**, si se concentran al final de una ventana y al inicio de la siguiente. Por ejemplo: 1 en `t0`, 4 en `t0 + 3599` y 5 en `t0 + 3600`.
  - Lo garantizado es "≤ 5 por ventana fija", no "≤ 5 en cualquier hora móvil".
  - Se acepta para el MVP. Si EIRA requiere una ventana deslizante estricta, se guardarían las últimas 5 marcas de tiempo en el mismo ítem, con control de versión optimista. Eso queda fuera del alcance actual.
- `:now` es el reloj de la Lambda; una desviación de segundos solo desplaza el borde de la ventana.

#### Algoritmo atómico

Cada emisión de PIN para un reto real ejecuta:

```text
1. GetItem Patients { patientId } ConsistentRead
     (proyección: pinWindowStartsAt, pinRequestCount)

2. Elegir la actualización del contador:
   si no hay ventana o pinWindowStartsAt <= :now - 3600:      // abrir ventana
     U = Update Patients { patientId }
           SET pinWindowStartsAt = :now, pinRequestCount = :one
           CONDITION attribute_not_exists(pinWindowStartsAt)
                     OR pinWindowStartsAt <= :now_minus_3600
   si no, si pinRequestCount < 5:                             // consumir cupo
     U = Update Patients { patientId }
           ADD pinRequestCount :one
           CONDITION pinWindowStartsAt > :now_minus_3600
                     AND pinRequestCount < :max               // :max = 5
   si no:
     límite alcanzado → paso 5

3. TransactWriteItems [ U, C ]
     C = Put PinChallenges (request; CONDITION attribute_not_exists(challengeId))
         o Update PinChallenges (resend; condiciones de 5.2)

4. Si la transacción se cancela:
     - ConditionalCheckFailed en Patients (otra solicitud cambió el contador)
       → volver al paso 1 (máximo 3 intentos en total)
     - TransactionConflict → reintento con backoff y jitter (dentro de los mismos 3)
     - ConditionalCheckFailed en PinChallenges (resend en enfriamiento, vencido, etc.)
       → error genérico de resend; el contador no cambia, porque la transacción no se aplicó

5. Límite alcanzado o reintentos agotados → no se genera PIN real ni se envía SMS.
   Se crea un reto señuelo, la respuesta es idéntica (202) y se audita PIN_RATE_LIMITED.

6. El SMS se envía solo después de que la transacción se confirma.
```

#### Por qué no se puede superar el límite

- DynamoDB evalúa la condición y aplica la escritura de forma **atómica y serializada sobre el mismo ítem**. El paso 1 es solo una pista para elegir la expresión; la garantía la dan las `CONDITION` del paso 2.
- **Consumir cupo:** condición atómica `pinWindowStartsAt > :now_minus_3600 AND pinRequestCount < 5`.
  - Con `pinRequestCount = 4`, de N escrituras concurrentes solo una ve `4 < 5` y deja el contador en 5. Las demás ven 5 y fallan.
  - Una escritura que llega cuando la ventana ya venció también falla, por la primera mitad de la condición. Así no se consume cupo de una ventana vencida.
  - El contador nunca pasa de 5 dentro de una ventana.
- **Abrir ventana:** condición atómica `attribute_not_exists(pinWindowStartsAt) OR pinWindowStartsAt <= :now_minus_3600`.
  - Si dos o más solicitudes concurrentes intentan abrir una ventana nueva, DynamoDB serializa las escrituras sobre el ítem. Solo la primera ve la ventana vencida y escribe `pinWindowStartsAt = :now`, `pinRequestCount = 1`.
  - Para las siguientes, `pinWindowStartsAt` ya es reciente, así que su condición falla y no pueden reiniciar el contador a 1 ni borrar emisiones ya contadas. Reintentan (paso 4) como "consumir cupo".
  - Una solicitud que leyó un estado viejo en el paso 1 tampoco puede actuar sobre él, porque la condición se evalúa contra el estado actual del ítem en el momento de escribir.
- **Solicitudes y reenvíos** actualizan el mismo atributo del mismo ítem, así que compiten por el mismo cupo.
- **Contador y reto en una sola transacción:** no puede existir un reto real (ni su SMS) sin cupo consumido, ni cupo consumido sin reto. Única excepción: si falla el envío del SMS después de confirmar, el cupo **no se devuelve** (falla en el lado seguro).
- Los retos señuelo no tocan ningún contador, porque no tienen expediente.

#### Otras reglas

- **Sin `429`:** al alcanzar el límite no se responde `429`, porque eso revelaría que el expediente existe.
- **IAM:** el rol solo puede actualizar esos dos atributos en `Patients` (condición `dynamodb:Attributes` con `ForAllValues:StringEquals` y `dynamodb:ReturnValues` = `NONE`). `TransactWriteItems` evalúa los permisos de `UpdateItem`/`PutItem` de cada elemento.
- **Cota de fuerza bruta por expediente:** 5 emisiones por ventana × 5 intentos por reto = 25 intentos por ventana, es decir, una probabilidad de acierto ≤ 25 / 10⁶ por ventana y por expediente, además de los límites por IP.

#### Pruebas previstas (etapa 3, DynamoDB Local y reloj simulado)

- 20 `request` concurrentes para un expediente → exactamente 5 retos reales, 5 SMS en el mock y `pinRequestCount == 5`.
- 10 `request` y 10 `resend` concurrentes → como máximo 5 emisiones en total.
- En `start + 3599` se rechaza; en `start + 3600` se abre una ventana nueva con `pinRequestCount == 1`.
- Varias solicitudes concurrentes en el borde de la ventana → una sola apertura, ningún reinicio adicional del contador y como máximo 5 emisiones en la ventana nueva.
- 5 emisiones al final de una ventana y 5 al inicio de la siguiente → se permiten las 10 (comportamiento esperado de la ventana fija), y la emisión 11 se rechaza.
- Un `resend` rechazado por enfriamiento no consume cupo.
- Si falla el SMS, el contador no disminuye.

---

## 2. Anti-enumeración

Objetivo: un tercero no debe poder distinguir si una combinación nombre/fecha/folio corresponde a un expediente existente.

### 2.1 Respuesta idéntica

| Aspecto             | Regla                                                                                                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Validación          | El formato se valida **antes** de cualquier búsqueda; un `400` depende solo de la forma de la entrada                                                                                                |
| Status              | `202` siempre, ya sea expediente válido, inexistente, datos que no coinciden, expediente deshabilitado o límite por paciente alcanzado                                                               |
| Cuerpo              | Mismo esquema y mismos valores constantes: `{ challengeId, expiresIn: 300, resendAfter: 60 }`. `challengeId` siempre es de 128 bits en base64url (longitud fija). Sin teléfono enmascarado ni nombre |
| Encabezados         | Los mismos (`Cache-Control: no-store`, CORS); sin cookies                                                                                                                                            |
| Errores posteriores | Mensajes genéricos ("Código incorrecto o expirado") iguales para retos reales y señuelo                                                                                                              |

### 2.2 Retos señuelo

Si los datos no coinciden (o el expediente está deshabilitado o sin cupo), se crea un ítem en `PinChallenges` con **el mismo esquema** que un reto real:

- `kind = DECOY` (atributo interno, nunca expuesto) y **sin** `patientId`.
- `pinHmac` = HMAC de un PIN aleatorio generado igual que uno real y descartado de inmediato (nadie lo conoce).
- Mismas reglas de expiración (5 min), intentos (5 → bloqueo), reenvío (60 s, máximo 3) y TTL.
- `verify` sobre un señuelo **nunca** crea sesión: la escritura de éxito exige `attribute_exists(patientId)` (sección 5). Responde igual que un PIN incorrecto e incrementa `attempts`, de modo que también se bloquea a los 5 intentos.
- `resend` sobre un señuelo aplica las mismas condiciones y respuestas (incluido el `429` por enfriamiento de 60 s, que depende solo del reto) y no envía SMS.

### 2.3 Tiempos de ejecución

1. **Mismo trabajo en ambos caminos:**
   - Siempre se calculan los tres HMAC (folio, nombre, fecha).
   - Siempre se hace el `Query` al GSI `FolioHashIndex`, que proyecta los atributos necesarios, sin `GetItem` adicional.
   - Si no hay expediente, se compara contra hashes ficticios con `timingSafeEqual`.
   - Siempre se escribe un ítem en `PinChallenges`.
2. **Tiempo mínimo de respuesta:** `requestAccess` y `resendPin` esperan hasta un piso fijo (`MIN_RESPONSE_MS`, inicial 1000 ms) más un jitter aleatorio de 0–50 ms. El piso cubre lo que solo hace el camino real (actualización condicional del contador y envío por `SmsProvider`).
3. **Vigilancia:** si el camino real supera el piso, se emite la métrica `ResponseFloorExceeded` con alarma en CloudWatch y el piso se ajusta. Con `AwsSnsSmsProvider` (futuro) se evaluará enviar el SMS de forma asíncrona.
4. `verifyPin` no necesita piso: un PIN incorrecto sigue el mismo camino (`GetItem` → comparación → `UpdateItem`) en retos reales y señuelo. El éxito ya es observable por definición.

### 2.4 Pruebas previstas (etapa 3)

- Igualdad estricta de status, encabezados y cuerpo (salvo `challengeId`) entre los casos inexistente, no coincidente, deshabilitado, límite alcanzado y válido.
- Prueba estadística de tiempos: distribuciones de N solicitudes por caso, con diferencia de medianas menor a un umbral.
- Comportamiento de `verify`/`resend` idéntico entre señuelo y real con PIN incorrecto.

---

## 3. Expiración

**Regla:** la expiración se valida **en cada operación** con `expiresAt`, tanto en la aplicación como en la `ConditionExpression` de las escrituras. El TTL de DynamoDB (atributo `ttl`, separado de `expiresAt`) **solo sirve de limpieza**, porque su borrado es asíncrono y un ítem vencido puede seguir siendo legible un tiempo.

| Objeto                  | Campo                                | Validación                                                                                                                    | `ttl` (limpieza)   |
| ----------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Reto PIN                | `expiresAt` = emisión + 300 s        | `verify` y `resend` comprueban `expiresAt > :now` en la aplicación **y** en la condición de escritura                         | `expiresAt + 24 h` |
| Enfriamiento de reenvío | `resendAvailableAt` = emisión + 60 s | Condición `resendAvailableAt <= :now`                                                                                         | —                  |
| Sesión                  | `expiresAt` = creación + 900 s       | El authorizer lee con `ConsistentRead: true` y exige `expiresAt > now` y `revoked <> true`; `ReauthorizeEvery: 0` (sin caché) | `expiresAt + 24 h` |
| URL de descarga         | `X-Amz-Expires=60`                   | La firma S3 expira por sí misma. Se emite solo con sesión vigente en ese momento                                              | —                  |

- `:now` lo calcula la Lambda (`Math.floor(Date.now() / 1000)`) una vez por solicitud y se usa en todas las comparaciones de esa solicitud.
- `resend` **no** reabre retos vencidos: exige `expiresAt > :now`. Si el PIN venció, la paciente inicia de nuevo con `request`. Un reenvío válido emite PIN nuevo con `expiresAt` renovado y **no** reinicia `attempts`.
- Un reto vencido que el TTL aún no borró es inutilizable porque todas las condiciones de escritura lo rechazan.

---

## 4. `demoPin`

Ver [ADR-0003](adr/0003-demo-pin.md) para la decisión completa. Resumen de los controles contra enumeración y fuga:

1. **Misma forma de respuesta:** en `demo`, **todas** las respuestas `202` de `request`/`resend` incluyen `demoPin`, sean reales o señuelo. En un señuelo es un PIN aleatorio que nunca valida. Así, la presencia del campo no revela si el expediente existe.
2. **Límite inherente:** `demoPin` elimina el factor de posesión (el teléfono). En `demo`, quien conozca nombre, fecha y folio de un expediente sintético puede entrar y, por tanto, distinguir en `verify` si existe. Esto es aceptable **solo** porque `demo` contiene exclusivamente datos sintéticos. Por eso:
   - **Aislamiento:** `demo` es un stack separado, con tablas, bucket, llaves y secretos propios (nombres con sufijo de stage). Se recomienda una cuenta AWS distinta.
   - **Guarda de datos sintéticos:** cada expediente tiene `dataClassification`. En `demo`, el alta administrativa y el seed fuerzan `SYNTHETIC`. Si en `demo` aparece un expediente sin `SYNTHETIC`, se trata como señuelo (no hay sesión posible; respuesta idéntica) y se emite la alarma `NonSyntheticRecordInDemo`.
3. **Condiciones de exposición** (todas obligatorias): `Stage=demo` + `SmsProvider=mock` en la plantilla + verificación en ejecución de que la instancia es `MockSmsProvider` + condición de datos sintéticos del punto anterior.
4. **Producción:**
   - `Rule` `Stage=prod ⇒ SmsProvider≠mock`, que hace fallar la plantilla.
   - El código rechaza arrancar con esa combinación.
   - El campo `demoPin` no existe en el esquema de respuesta de `prod`; una prueba de contrato lo verifica.
5. **Nunca persistido ni registrado:**
   - No se guarda en DynamoDB (solo `pinHmac`).
   - El logger redacta `pin`/`demoPin` y no se registran cuerpos de respuesta.
   - API Gateway usa `DataTraceEnabled: false` y access logs sin cuerpo.
   - El frontend lo muestra en memoria con el aviso "Entorno de demostración" y no lo guarda en el almacenamiento del navegador.

---

## 5. Concurrencia y escrituras condicionales

Todas las transiciones de estado de un reto o una sesión son **escrituras condicionales atómicas**. Las lecturas previas usan `ConsistentRead: true`.

### 5.1 `verifyPin`

```text
item = GetItem PinChallenges { challengeId } (ConsistentRead)
computed = HMAC(pinSecret, challengeId + ":" + pin)
ok = item existe && timingSafeEqual(computed, item.pinHmac)

si ok:
  TransactWriteItems [
    Update PinChallenges { challengeId }
      SET #status = :used, usedAt = :now
      CONDITION #status = :pending AND attempts < :max AND expiresAt > :now
                AND pinHmac = :computed AND attribute_exists(patientId),
    Put AccessSessions { tokenHash, patientId, expiresAt, ... }
      CONDITION attribute_not_exists(tokenHash),
    Put AuditLog { SESSION_CREATED ... }
      CONDITION attribute_not_exists(pk)
  ]
  si la transacción se cancela por condición → se trata como fallo (abajo)

si no ok (o transacción cancelada):
  r = UpdateItem PinChallenges { challengeId }
        ADD attempts :one
        CONDITION #status = :pending AND attempts < :max AND expiresAt > :now
        RETURN UPDATED_NEW
  si r.attempts >= :max:
     UpdateItem SET #status = :locked CONDITION #status = :pending AND attempts >= :max
  responder 401 genérico (o 423 si está bloqueado; los señuelos también se bloquean, así que no revela existencia)
```

Garantías:

- **Uso único:** la condición `#status = :pending` hace que, de N verificaciones correctas concurrentes, solo una transacción tenga éxito.
- **Máximo 5 intentos:** el incremento exige `attempts < :max`, así que nunca se superan 5 fallos aunque lleguen en paralelo. La transacción de éxito también exige `attempts < :max`; por eso `LOCKED` es informativo y el bloqueo real lo impone el contador.
- **PIN cambiado por un reenvío** entre la lectura y la escritura: `pinHmac = :computed` falla y se cuenta como intento fallido.
- **Atomicidad de sesión:** consumir el PIN, crear la sesión y auditar ocurren juntos o no ocurren (sin PIN consumido y sin sesión).

### 5.2 `resendPin`

```text
UpdateItem PinChallenges { challengeId }
  SET pinHmac = :newHmac, expiresAt = :now_plus_300, resendAvailableAt = :now_plus_60
  ADD resendCount :one
  CONDITION #status = :pending AND expiresAt > :now
            AND resendAvailableAt <= :now AND resendCount < :maxResends
```

En retos reales, este `Update` va en la misma `TransactWriteItems` que el contador por paciente (sección 1.3), así que un reenvío rechazado no consume cupo. `attempts` no se modifica.

### 5.3 `requestAccess`

- `PutItem PinChallenges` con `CONDITION attribute_not_exists(challengeId)`.
- En retos reales, este `Put` va en la misma `TransactWriteItems` que el contador por paciente (sección 1.3).

### 5.4 Sesiones

- **Validación** (authorizer): `GetItem` con `ConsistentRead`, solo lectura.
- **Revocación:** `UpdateItem SET revoked = :true CONDITION attribute_exists(tokenHash)`.

### 5.5 Descarga

`GetItem Results` + comprobación de `patientId` y `status`. Después, `PutItem AuditLog` (`DOWNLOAD_URL_ISSUED`) **antes** de firmar la URL. Si la auditoría falla, no se emite URL (fail-closed).

### 5.6 Pruebas previstas (etapa 3, DynamoDB Local)

- 20 `verify` incorrectos en paralelo → `attempts == 5`.
- 10 `verify` correctos en paralelo → exactamente 1 sesión.
- `verify` correcto concurrente con `resend` → nunca valida el PIN anterior después del reenvío.
- Concurrencia del límite por paciente: ver las pruebas de la sección 1.3.
