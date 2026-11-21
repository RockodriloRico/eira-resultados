# ADR-0002: API REST y sesión de paciente con token opaco

- Estado: Aceptada

## Decisión

- **Amazon API Gateway REST API**: throttling por método, request validators, Lambda authorizer, integración con AWS WAF y access logs.
- **Sesión de paciente**: token opaco de 256 bits generado con `crypto.randomBytes` y vigencia de 15 minutos.
  - En `AccessSessions` solo se guarda `SHA-256(token)`. El token en claro solo lo conoce el cliente, que lo mantiene en memoria (no en `localStorage`).
  - Revocación: logout o acción administrativa marcan `revoked=true`. El authorizer se configura sin caché (`ReauthorizeEvery: 0`), así que la revocación es inmediata.
  - El authorizer entrega `patientId` en el contexto. Los handlers nunca aceptan `patientId` del cliente.

## Alternativas descartadas

- HTTP API: más barata, pero con menos controles (sin WAF directo ni request validators).
- JWT firmado para la paciente: sin estado, pero difícil de revocar antes de que expire.

## Consecuencias

- Una lectura de DynamoDB por petición autenticada (aceptable para el volumen del MVP).
