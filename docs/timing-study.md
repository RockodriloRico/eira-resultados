# Prueba estadística de tiempos anti-enumeración

Decisión en [ADR-0014](adr/0014-verificacion-posterior-al-despliegue.md).

## Cómo reproducirla

```
npm run dynamodb:up
EIRA_TIMING_REPORT=timing-report.json npx vitest run --root backend \
  --config vitest.integration.config.ts tests/integration/operations.integration.test.ts
```

- Usa el servidor local con `MIN_RESPONSE_MS=1000`, jitter de 0–50 ms y 60 expedientes sintéticos.
- Envía 10 solicitudes de calentamiento que se descartan y después 90 solicitudes (30 por clase) con 5 en paralelo.
- La semilla `20261122` fija el orden de las 90 solicitudes; el barajado reproducible está probado en `stats.test.ts`.
- Los tiempos absolutos cambian entre máquinas. Los criterios son fijos y deben cumplirse siempre.

## Qué se comprueba y qué no

La prueba separa tres preguntas distintas. Cada una tiene su propio criterio y ninguna sustituye a las otras.

| Pregunta                                            | Criterio                                                                                              | Naturaleza                                                                               |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1. ¿Alguna respuesta sale antes del piso?           | Mínimo ≥ 1000 ms en cada clase                                                                        | Determinista: una sola respuesta antes de 1000 ms es un defecto                          |
| 2. ¿El piso oculta el trabajo real?                 | p95 ≤ 1300 ms (piso + 50 ms de jitter + 250 ms de margen de red y cliente); `aboveMask` en el informe | Rendimiento: si el trabajo supera piso + jitter, el tiempo vuelve a depender de la clase |
| 3. ¿Se distinguen las clases por su tiempo?         | Mann-Whitney bilateral, α = 0.001, entre cada par de clases                                           | Prueba de diferencia: p ≥ α significa **no se detectó** diferencia, no que no exista     |
| 3b. ¿Se puede afirmar que las clases son similares? | IC del 90 % del desplazamiento (Hodges-Lehmann) dentro de ±25 ms                                      | Prueba de equivalencia (TOST, α = 0.05 por lado) con un margen fijado de antemano        |

Además, las tres clases deben responder solo `202` con el mismo esquema de cuerpo.

### Interpretación de los valores p

- Un valor p alto (por ejemplo, p ≥ 0.43 en el resultado de la etapa 3) **no prueba equivalencia**. Solo indica que, con esta muestra, no se detectó una diferencia.
- La afirmación positiva que permite la prueba es la de equivalencia: el desplazamiento entre clases está, con un 90 % de confianza, dentro de ±25 ms.
- Con tres comparaciones por ejecución y α = 0.001, la probabilidad de un falso positivo es de aproximadamente 0.3 % por ejecución.

### Limitaciones de 30 solicitudes por clase

Potencia estimada por simulación (2000 repeticiones, jitter uniforme de 0–50 ms, `stats.ts`):

| Desplazamiento real | Mann-Whitney detecta (p < 0.001) | El IC 90 % queda en ±25 ms |
| ------------------- | -------------------------------- | -------------------------- |
| 0 ms                | 0.1 %                            | 100 %                      |
| 5 ms                | 1 %                              | 99.9 %                     |
| 10 ms               | 16 %                             | 98 %                       |
| 15 ms               | 55 %                             | 80 %                       |
| 20 ms               | 90 %                             | 36 %                       |

- El IC del 90 % mide unos 13 ms de ancho. Con n = 30, la prueba **no puede descartar** desplazamientos menores de unos 10 ms: no se detectarían y caben dentro del margen.
- Un atacante con miles de solicitudes podría distinguir diferencias menores. La protección no depende de esta prueba, sino de que el trabajo quede por debajo del piso: en ese caso el tiempo es piso + jitter, independiente de la clase. En AWS lo vigila la alarma `ResponseFloorExceeded`, y el WAF limita las solicitudes por IP.
- La prueba compara desplazamientos (posición). No evalúa diferencias en la forma de la distribución, por ejemplo colas más largas en una clase.
- La prueba local mide la lógica (piso, jitter y trabajo equivalente) sobre DynamoDB Local, no la red ni Lambda.

## Causa de la falla intermitente y corrección

Reproducción con el estudio local (semilla `20261122`):

| Concurrencia                   | Respuestas por encima de piso + jitter (por clase) | p95 (ms)  | Resultado                            |
| ------------------------------ | -------------------------------------------------- | --------- | ------------------------------------ |
| 15                             | 3–8 de 30                                          | 1064–1130 | Pasa, cerca del límite               |
| 40                             | 14–19 de 30                                        | 1335–1416 | Falla: p95 y diferencias de medianas |
| 60                             | 18–22 de 30                                        | 1458–1537 | Falla                                |
| 5 (sin la corrección del piso) | 0–1 de 30                                          | 1046–1052 | Falla 1 de 3: mínimo de 999.7 ms     |

Dos causas:

1. **Saturación local.** Con 15 solicitudes simultáneas contra un solo proceso de Node.js y DynamoDB Local, el trabajo real superaba el piso en varias solicitudes. Con la máquina cargada, el p95 o las medianas superaban los umbrales. En Lambda cada invocación tiene su propio entorno, así que esta saturación no se reproduce igual.
2. **Defecto real del piso.** `setTimeout` trabaja con milisegundos enteros y con el reloj del event loop, y puede despertar hasta ~1 ms antes. Una respuesta salía en 999.7 ms, antes del piso.

Corrección, sin reducir la protección:

- `withResponseFloor` repite la espera hasta que `performance.now()` confirma el piso. El piso de 1000 ms y el jitter de 0–50 ms no cambian. Prueba unitaria con un temporizador que despierta 1 ms antes.
- La prueba local usa 5 solicitudes en paralelo y 10 de calentamiento descartadas. Los umbrales (1000 ms, 1300 ms, α = 0.001, ±25 ms) no cambian.
- El espaciado del script contra `demo` también repite la espera, para no adelantar solicitudes ante el límite del WAF.

Después de la corrección pasaron 8 de 8 ejecuciones consecutivas, con la máquina cargada por otras pruebas.

## Resultado local (8 ejecuciones tras la corrección, DynamoDB Local, 5 en paralelo)

| Medida                                               | Rango en las 8 ejecuciones |
| ---------------------------------------------------- | -------------------------- |
| Mínimo por clase                                     | 1000.9–1006.4 ms           |
| p95 por clase                                        | 1042.7–1059.5 ms           |
| Respuestas por encima de piso + jitter (`aboveMask`) | 0–6 de 30 por clase        |
| Mann-Whitney, p mínimo de las 24 comparaciones       | 0.039                      |
| IC 90 % del desplazamiento, extremos                 | −20.4 a 10.8 ms            |

Ninguna respuesta sale antes de 1000 ms, ninguna comparación es significativa con α = 0.001 y todos los intervalos quedan dentro de ±25 ms. Los `aboveMask` incluyen la latencia del cliente local (por encima de 1050 ms en pocos milisegundos).

## Contra demo (después de un despliegue autorizado)

```
npm run timing:study -- --api <ApiUrl> --n 30 --seed 20261122 --out timing-demo.json
```

Solo usa folios sintéticos con una fecha incorrecta y folios inexistentes, así que no envía SMS. Envía 3 solicitudes de calentamiento que se descartan (arranque en frío de Lambda).

La regla del WAF `AccessRequestPerIp` bloquea con `429` más de 20 solicitudes de acceso por IP en 300 s. Por eso el script envía una solicitud cada 16 s (`--interval-ms 16000`) y las 63 solicitudes tardan unos 17 minutos. No hay que lanzarlo justo después de los smoke tests, ni desde varias terminales a la vez.
