import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { runTimingStudy, type TimingClass } from '../src/ops/timingStudy.ts';

// Prueba de tiempos contra un entorno desplegado (demo). Usa solo identidades inexistentes o no
// coincidentes con los folios sintéticos; no crea sesiones. Semilla y umbrales fijos (ADR-0014).
const { values } = parseArgs({
  options: {
    api: { type: 'string' },
    n: { type: 'string', default: '30' },
    seed: { type: 'string', default: '20261122' },
    out: { type: 'string', default: 'timing-report.json' },
    // El WAF bloquea más de 20 solicitudes de acceso por IP en 300 s: 16 s entre solicitudes.
    'interval-ms': { type: 'string', default: '16000' },
  },
});
if (!values.api) {
  process.stderr.write('Uso: npm run timing:study -- --api <ApiUrl> [--n 30] [--seed 20261122]\n');
  process.exit(2);
}
const n = Number(values.n);
const classes: TimingClass[] = [
  {
    name: 'folio-sintetico-fecha-incorrecta',
    bodies: Array.from({ length: n }, (_, i) => ({
      fullName: 'Ana Prueba Sintética',
      birthDate: `1960-01-${String((i % 28) + 1).padStart(2, '0')}`,
      folio: 'SINT-0001',
    })),
  },
  {
    name: 'folio-inexistente',
    bodies: Array.from({ length: n }, (_, i) => ({
      fullName: 'Persona Inexistente',
      birthDate: '1980-05-05',
      folio: `SINT-X${String(i).padStart(4, '0')}`,
    })),
  },
];
const report = await runTimingStudy({
  apiUrl: values.api,
  classes,
  seed: Number(values.seed),
  concurrency: 1,
  intervalMs: Number(values['interval-ms']),
});
// eslint-disable-next-line security/detect-non-literal-fs-filename -- ruta indicada por el operador
writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report.comparisons)}\nFallas: ${report.failures.length}\n`);
process.exit(report.failures.length === 0 ? 0 : 1);
