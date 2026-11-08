/**
 * Runtime-agnostic HTTP serving.
 *
 * The Hono application is a plain fetch handler, so the same code runs on Bun
 * and on Node.js. Bun is used when it is available; otherwise the server is
 * served through `@hono/node-server`.
 */

export type Runtime = 'bun' | 'node';

export interface ServeHttpOptions {
  fetch: (request: Request) => Response | Promise<Response>;
  port: number;
  hostname: string;
}

export interface RunningServer {
  runtime: Runtime;
  port: number;
  stop: () => Promise<void>;
}

export function detectRuntime(): Runtime {
  return typeof (globalThis as { Bun?: unknown }).Bun === 'undefined' ? 'node' : 'bun';
}

export async function serveHttp(options: ServeHttpOptions): Promise<RunningServer> {
  if (detectRuntime() === 'bun') {
    const server = Bun.serve({
      fetch: options.fetch,
      port: options.port,
      hostname: options.hostname,
    });

    return {
      runtime: 'bun',
      port: server.port ?? options.port,
      stop: async () => {
        await server.stop();
      },
    };
  }

  const { serve } = await import('@hono/node-server');

  return new Promise<RunningServer>((resolve, reject) => {
    let listening = false;
    const server = serve(
      {
        fetch: options.fetch,
        port: options.port,
        hostname: options.hostname,
      },
      (info) => {
        listening = true;
        resolve({
          runtime: 'node',
          port: info.port,
          stop: () =>
            new Promise<void>((stopped, failed) => {
              server.close((error) => (error ? failed(error) : stopped()));
            }),
        });
      },
    );

    server.on('error', (error) => {
      if (!listening) reject(error);
    });
  });
}
