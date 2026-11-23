import { parseArgs } from 'node:util';
import { seedSyntheticViaApi } from '../src/ops/seedDemo.ts';

// Seed sintético mediante la API administrativa. El token se lee de EIRA_ADMIN_ACCESS_TOKEN
// (access token de Cognito de un usuario del grupo admins); nunca se pasa como argumento.
const { values } = parseArgs({
  options: { stage: { type: 'string' }, api: { type: 'string' } },
});
if (!values.api || !['dev', 'demo'].includes(values.stage ?? '')) {
  process.stderr.write(
    'Uso: EIRA_ADMIN_ACCESS_TOKEN=… npm run seed:demo -- --stage demo --api <ApiUrl>\n',
  );
  process.exit(2);
}
const token = process.env.EIRA_ADMIN_ACCESS_TOKEN;
const result = await seedSyntheticViaApi({
  apiUrl: values.api,
  stage: values.stage as 'dev' | 'demo',
  ...(token ? { accessToken: token } : {}),
  log: (line) => process.stdout.write(`${line}\n`),
});
process.stdout.write(`Elementos sintéticos creados: ${result.created}\n`);
