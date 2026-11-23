/* eslint-disable security/detect-non-literal-fs-filename -- solo recorre frontend/dist */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Comprueba que el build publicable sea el mismo para todos los entornos y no lleve nada local.
const dist = new URL('../dist/', import.meta.url).pathname;
const FORBIDDEN = ['local-admin-sintetico', '127.0.0.1:3001', 'SINT-000'];
const problems: string[] = [];
const files = (await readdir(dist, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath, entry.name));

for (const file of files) {
  const name = file.slice(dist.length);
  if (name === 'config.json')
    problems.push('config.json no debe ir en el build; se genera por entorno');
  if (name.endsWith('.map')) problems.push(`source map publicado: ${name}`);
  const text = await readFile(file, 'utf8');
  for (const needle of FORBIDDEN)
    if (text.includes(needle)) problems.push(`${name} contiene ${needle}`);
  if (name === 'index.html' && /<script(?![^>]*\bsrc=)[^>]*>/.test(text))
    problems.push('index.html tiene scripts en línea (la CSP solo permite script-src self)');
}
if (problems.length) {
  process.stderr.write(`Build del frontend inválido:\n- ${problems.join('\n- ')}\n`);
  process.exit(1);
}
process.stdout.write(`Build del frontend verificado (${files.length} archivos)\n`);
