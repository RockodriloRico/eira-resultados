import { startDevServer } from './devServer.ts';

// Uso: npm run demo:api. Solo 127.0.0.1, DynamoDB Local y datos sintéticos.
const port = Number(process.env.LOCAL_API_PORT ?? 3001);
const { url } = await startDevServer({
  port,
  dataDir: new URL('../../../.local-data', import.meta.url).pathname,
  publicUrl: process.env.LOCAL_PUBLIC_URL ?? 'http://127.0.0.1:5173',
});
process.stdout.write(`API local (solo 127.0.0.1, datos sintéticos): ${url}\n`);
