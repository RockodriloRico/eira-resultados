import { spawn } from 'node:child_process';

// Demo local completa: API (127.0.0.1:3001, DynamoDB Local, datos sintéticos) + Vite (127.0.0.1:5173).
const children = [
  spawn('npm', ['run', 'demo:api'], { stdio: 'inherit' }),
  spawn('npm', ['run', 'dev', '-w', '@eira/frontend'], { stdio: 'inherit' }),
];
const stop = () => {
  for (const child of children) child.kill('SIGTERM');
};
for (const child of children) child.on('exit', (code) => (stop(), (process.exitCode = code ?? 0)));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
