import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const env = { ...process.env };

const api = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
  stdio: 'inherit',
  env,
});
const vite = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--config', path.join(root, 'web', 'vite.config.js')], {
  stdio: 'inherit',
  env,
});

const stop = () => {
  api.kill();
  vite.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
api.on('exit', (c) => {
  if (c) {
    vite.kill();
    process.exit(c);
  }
});
vite.on('exit', (c) => {
  if (c) {
    api.kill();
    process.exit(c);
  }
});
