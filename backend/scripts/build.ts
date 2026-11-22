/* eslint-disable security/detect-non-literal-fs-filename -- rutas fijas dentro del propio backend */
import { build } from 'esbuild';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Empaqueta cada handler como ESM para Lambda nodejs24.x (arm64). Uso: npm run build -w @eira/backend
const root = new URL('..', import.meta.url).pathname;
const handlersDir = join(root, 'src', 'handlers');
const outdir = join(root, 'dist');

const entryPoints = (await readdir(handlersDir))
  .filter((file) => file.endsWith('.ts'))
  .map((file) => join(handlersDir, file));

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await build({
  entryPoints,
  outdir,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  sourcemap: true,
  minify: false,
  external: ['@aws-sdk/*'],
  logLevel: 'warning',
});
// SAM (NodejsNpmBuilder) requiere un package.json en CodeUri.
await writeFile(
  join(outdir, 'package.json'),
  `${JSON.stringify({ name: 'eira-lambda-bundle', version: '0.0.0', private: true, type: 'module' }, null, 2)}\n`,
);
