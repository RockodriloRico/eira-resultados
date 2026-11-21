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

**Decisión:** la plantilla incluye `AWS::WAFv2::WebACL` (scope `REGIONAL`) y `AWS::WAFv2::WebACLAssociation` con el stage de la API REST, bajo el parámetro `EnableWaf` (por defecto `true`).

- Una `Rule` de CloudFormation impide `Stage=prod` con `EnableWaf=false`.
- En `dev`/`demo` puede desactivarse por costo. En ese caso **la limitación por IP no existe en ese entorno** y queda documentada como limitación conocida del MVP; siguen vigentes el throttling agregado y el límite por paciente.
- Ver [ADR-0008](adr/0008-limitacion-de-tasa.md).

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

Atributos en el ítem de `Patients`: `pinWindowStartsAt` (epoch s) y `pinRequestCount` (N). Límite inicial: **5 SMS por paciente por hora**, sumando solicitudes y reenvíos.

Cada emisión de PIN, en `requestAccess` y en `resendPin` para retos reales, ejecuta antes de enviar el SMS:

```text
// Intento A: abrir una ventana nueva si no existe o ya venció
UpdateItem Patients { patientId }
  SET pinWindowStartsAt = :now, pinRequestCount = :one
  CONDITION attribute_not_exists(pinWindowStartsAt) OR pinWindowStartsAt <= :now_minus_3600

// Si A falla con ConditionalCheckFailed → Intento B: consumir cupo en la ventana vigente
UpdateItem Patients { patientId }
  ADD pinRequestCount :one
  CONDITION pinWindowStartsAt > :now_minus_3600 AND pinRequestCount < :max   // :max = 5

// Si B también falla → límite alcanzado
```

- Ambas operaciones son atómicas. Con solicitudes concurrentes, como máximo `:max` llegan a enviar SMS por ventana.
- **Límite alcanzado:** no se genera PIN real ni se envía SMS. Se crea un **reto señuelo** y la respuesta es idéntica (`202`); solo se audita `PIN_RATE_LIMITED`. No se responde `429`, porque eso revelaría que el expediente existe.
- **IAM:** el rol solo puede actualizar esos dos atributos (condición `dynamodb:Attributes` con `ForAllValues:StringEquals` y `dynamodb:ReturnValues` = `NONE`).
- **Cota de fuerza bruta por expediente:** 5 emisiones por hora × 5 intentos por reto = 25 intentos por hora, es decir, una probabilidad de acierto ≤ 25 / 10⁶ por hora y por expediente, además de los límites por IP.

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

En retos reales, antes de enviar el SMS se aplica también el límite por paciente (sección 1.3). `attempts` no se modifica.

### 5.3 `requestAccess`

- `PutItem PinChallenges` con `CONDITION attribute_not_exists(challengeId)`.
- En retos reales, actualización condicional del contador por paciente (sección 1.3).

### 5.4 Sesiones

- **Validación** (authorizer): `GetItem` con `ConsistentRead`, solo lectura.
- **Revocación:** `UpdateItem SET revoked = :true CONDITION attribute_exists(tokenHash)`.

### 5.5 Descarga

`GetItem Results` + comprobación de `patientId` y `status`. Después, `PutItem AuditLog` (`DOWNLOAD_URL_ISSUED`) **antes** de firmar la URL. Si la auditoría falla, no se emite URL (fail-closed).

### 5.6 Pruebas previstas (etapa 3, DynamoDB Local)

- 20 `verify` incorrectos en paralelo → `attempts == 5`.
- 10 `verify` correctos en paralelo → exactamente 1 sesión.
- `verify` correcto concurrente con `resend` → nunca valida el PIN anterior después del reenvío.
- N `request` concurrentes para un expediente → como máximo 5 SMS por hora.
