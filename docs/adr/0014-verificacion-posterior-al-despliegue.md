# ADR-0014: Smoke tests, seed sintético y prueba estadística de tiempos

- Estado: Aceptada (etapa 3, entrega 5)

## Decisión

- **Smoke tests** (`npm run smoke`, `backend/src/ops/smoke.ts`):
  - Solo usan HTTP público, sin credenciales de AWS, con una identidad inexistente.
  - No crean sesiones, no envían SMS y no leen datos de pacientes.
  - Comprueban encabezados de seguridad de CloudFront y `config.json` (válido, sin caché y del mismo entorno).
  - También verifican: `202` genérico con el piso de 1000 ms, `demoPin` solo en `demo`, y `401`/`403` sin sesión, con un token inventado y en la API administrativa sin Cognito.
- **Seed sintético** (`npm run seed:demo`, `backend/src/ops/seedDemo.ts`):
  - Usa la API administrativa con el access token de Cognito de una persona del grupo `admins`, leído de `EIRA_ADMIN_ACCESS_TOKEN`. Pasa por los mismos permisos, la misma auditoría y la misma revisión de tres casillas.
  - Solo admite folios `SINT-` y PDFs con la leyenda "DOCUMENTO SINTETICO - SIN VALOR CLINICO". Se rechaza en `prod` y es idempotente.
- **Prueba estadística de tiempos** (`operations.integration.test.ts` en CI; `npm run timing:study` contra `demo`):
  - Tres clases de identidad (existente, no coincidente e inexistente), 30 solicitudes por clase.
  - El orden se baraja con una semilla fija (`20261122`).
  - Criterios fijos:
    - Mínimo ≥ 1000 ms y p95 ≤ 1300 ms.
    - Solo `202`, con el mismo esquema.
    - Mann-Whitney bilateral entre cada par de clases con α = 0.001, y diferencia de medianas ≤ 25 ms.
  - Detalle y resultados en [timing-study.md](../timing-study.md).

## Consecuencias

- La prueba local mide la lógica (piso, jitter y trabajo equivalente), no la red de AWS. Contra `demo`, `timing:study` usa solo identidades no coincidentes e inexistentes, para no enviar SMS ni crear retos reales.
- Mann-Whitney no prueba la ausencia de diferencias. Con n = 30 detecta, con α = 0.001, desplazamientos sistemáticos de unos 20 ms (prueba unitaria). Diferencias menores quedan dentro del jitter de 0–50 ms.
