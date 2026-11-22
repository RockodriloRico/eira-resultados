# scripts

Scripts de soporte para desarrollo local.

> Regla: **solo datos sintéticos**. Nunca uses nombres, folios, teléfonos ni resultados reales.

- `demo.ts`: `npm run demo` arranca la API local (`backend/src/local/start.ts`) y Vite. El seed de
  `backend/src/local/seed.ts` crea 3 expedientes sintéticos (`SINT-0001…0003`) y genera los PDF al
  ejecutar, con la leyenda "DOCUMENTO SINTETICO - SIN VALOR CLINICO". Los datos quedan en
  `.local-data/` (ignorado por git) y en DynamoDB Local.
