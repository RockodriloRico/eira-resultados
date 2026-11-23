# Prueba estadística de tiempos anti-enumeración

Decisión en [ADR-0014](adr/0014-verificacion-posterior-al-despliegue.md).

## Cómo reproducirla

```
npm run dynamodb:up
EIRA_TIMING_REPORT=timing-report.json npx vitest run --root backend \
  --config vitest.integration.config.ts tests/integration/operations.integration.test.ts
```

- Usa el servidor local con `MIN_RESPONSE_MS=1000`, jitter de 0–50 ms y 60 expedientes sintéticos.
- La semilla `20261122` fija el orden de las 90 solicitudes; el barajado reproducible está probado en `stats.test.ts`.
- Los tiempos absolutos cambian entre máquinas. Los criterios son fijos y deben cumplirse siempre.

## Resultado local (2026-11-22, DynamoDB Local, 15 solicitudes concurrentes)

| Clase          | n   | mín (ms) | mediana | p95    | máx    |
| -------------- | --- | -------- | ------- | ------ | ------ |
| existente      | 30  | 1002.1   | 1025.6  | 1102.8 | 1107.1 |
| no coincidente | 30  | 1000.6   | 1032.2  | 1064.5 | 1069.4 |
| inexistente    | 30  | 1003.8   | 1034.0  | 1078.8 | 1086.1 |

| Comparación                  | U   | p    | Δ mediana (ms) |
| ---------------------------- | --- | ---- | -------------- |
| existente / no coincidente   | 427 | 0.74 | 6.6            |
| existente / inexistente      | 396 | 0.43 | 8.4            |
| no coincidente / inexistente | 410 | 0.56 | 1.8            |

Las tres clases responden solo `202` con el mismo esquema. Ninguna respuesta sale antes de 1000 ms y ninguna comparación es significativa con α = 0.001.

## Contra demo (después de un despliegue autorizado)

```
npm run timing:study -- --api <ApiUrl> --n 30 --seed 20261122 --out timing-demo.json
```

Solo usa folios sintéticos con una fecha incorrecta y folios inexistentes, así que no envía SMS.

La regla del WAF `AccessRequestPerIp` bloquea con `429` más de 20 solicitudes de acceso por IP en 300 s. Por eso el script envía una solicitud cada 16 s (`--interval-ms 16000`) y las 60 solicitudes tardan unos 16 minutos. No hay que lanzarlo justo después de los smoke tests, ni desde varias terminales a la vez.
