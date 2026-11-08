#!/usr/bin/env node
/**
 * Local development launcher.
 *
 * Starts the auth service, the API, the worker, the scheduler and the web app
 * together, with prefixed output so it is obvious which process printed what.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const COLORS = {
  auth: '\u001b[34m',
  api: '\u001b[36m',
  worker: '\u001b[35m',
  scheduler: '\u001b[33m',
  web: '\u001b[32m',
  reset: '\u001b[0m',
};

const processes = [];

function run(name, command, args, cwd = root) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, FORCE_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const prefix = `${COLORS[name] ?? ''}[${name}]${COLORS.reset}`;
  const pipe = (stream, target) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) target.write(`${prefix} ${line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on('exit', (code) => {
    process.stdout.write(`${prefix} exited with code ${code}\n`);
  });

  processes.push(child);
  return child;
}

function shutdown() {
  for (const child of processes) {
    child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (!existsSync(resolve(root, '.env'))) {
  process.stderr.write('No .env file found. Copy .env.example to .env and adjust it.\n');
  process.exit(1);
}

console.log('Starting s9 in development mode. Press Ctrl+C to stop.\n');

run('auth', 'pnpm', ['--filter', '@s9/server', 'dev:auth']);
run('api', 'pnpm', ['--filter', '@s9/server', 'dev:api']);
run('worker', 'pnpm', ['--filter', '@s9/server', 'dev:worker']);
run('scheduler', 'pnpm', ['--filter', '@s9/server', 'dev:scheduler']);
run('web', 'pnpm', ['--filter', '@s9/web', 'dev']);
