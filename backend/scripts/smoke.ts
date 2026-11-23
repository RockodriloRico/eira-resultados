import { parseArgs } from 'node:util';
import { runSmoke } from '../src/ops/smoke.ts';

// Smoke tests posteriores al despliegue: solo HTTP público, sin credenciales de AWS.
const { values } = parseArgs({
  options: {
    stage: { type: 'string' },
    api: { type: 'string' },
    frontend: { type: 'string' },
  },
});
const stage = values.stage;
if (!values.api || !['dev', 'demo', 'prod', 'local'].includes(stage ?? '')) {
  process.stderr.write(
    'Uso: npm run smoke -- --stage <dev|demo|prod> --api <ApiUrl> --frontend <FrontendUrl>\n',
  );
  process.exit(2);
}
const checks = await runSmoke({
  apiUrl: values.api,
  stage: stage as 'dev' | 'demo' | 'prod' | 'local',
  ...(values.frontend ? { frontendUrl: values.frontend } : {}),
});
for (const c of checks) process.stdout.write(`${c.ok ? 'OK  ' : 'FALLA'} ${c.name}: ${c.detail}\n`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
