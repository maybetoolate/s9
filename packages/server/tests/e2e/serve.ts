import { spawn } from 'node:child_process';

/**
 * The E2E runtime.
 *
 * Starts the API and the worker as child processes of one Playwright
 * `webServer` entry. Playwright opens the group when it starts the command and
 * kills the whole process group afterwards, so both processes share its
 * lifetime.
 *
 * The worker is part of the fixture because the UI tests assert on executions
 * that actually run, not only on rows that are queued.
 */

const children = [
  spawn('bun', ['src/main-api.ts'], { stdio: 'inherit' }),
  spawn('bun', ['src/main-worker.ts'], { stdio: 'inherit' }),
];

let shuttingDown = false;

function shutdown(exitCode: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  // Give the processes a moment to release the database pool and Redis
  // connections before the wrapper exits.
  setTimeout(() => process.exit(exitCode), 500);
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

for (const child of children) {
  child.on('error', (error) => {
    process.stderr.write(`[e2e] a server could not start: ${error.message}\n`);
    shutdown(1);
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    process.stderr.write(`[e2e] a server exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})\n`);
    shutdown(code ?? 1);
  });
}
