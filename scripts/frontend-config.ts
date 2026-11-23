import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DEPLOYED_STAGES, type DeployedStage, buildFrontendConfig } from '@eira/shared';

// Genera frontend/dist/config.json a partir de las salidas del stack guardadas en un archivo
// (`aws cloudformation describe-stacks --stack-name ... > outputs.json`). No consulta AWS.
const { values } = parseArgs({
  options: {
    stage: { type: 'string' },
    outputs: { type: 'string' },
    out: { type: 'string', default: 'frontend/dist/config.json' },
  },
});
const stage = values.stage as DeployedStage;
if (!DEPLOYED_STAGES.includes(stage) || !values.outputs) {
  process.stderr.write(
    'Uso: npm run frontend:config -- --stage <dev|demo|prod> --outputs <archivo.json> [--out <ruta>]\n',
  );
  process.exit(2);
}
type Outputs = { OutputKey?: string; OutputValue?: string }[];
type Input = Outputs | { Outputs?: Outputs; Stacks?: { Outputs?: Outputs }[] };
// eslint-disable-next-line security/detect-non-literal-fs-filename -- ruta indicada por el operador
const input = JSON.parse(readFileSync(values.outputs, 'utf8')) as Input;
const outputs = Array.isArray(input) ? input : (input.Outputs ?? input.Stacks?.[0]?.Outputs ?? []);
const config = buildFrontendConfig(stage, outputs);
// eslint-disable-next-line security/detect-non-literal-fs-filename -- ruta indicada por el operador
writeFileSync(values.out, `${JSON.stringify(config, null, 2)}\n`);
process.stdout.write(`config.json (${stage}) escrito en ${values.out}\n`);
