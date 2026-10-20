import { API_INTERNAL_URL, API_PUBLIC_URL } from '@/lib/api-url';

/**
 * The API proxy.
 *
 * The browser only ever talks to the web app, and the web app forwards the
 * call to the API. A Next.js rewrite cannot be used for this: the rewrite
 * destination is resolved at build time and baked into the routes manifest,
 * so the image would be tied to the address of the API at build time. This
 * route handler resolves the address when the request arrives, which keeps a
 * single image usable in every environment.
 */

export const dynamic = 'force-dynamic';

function apiBaseUrl(): string {
  return API_INTERNAL_URL() ?? API_PUBLIC_URL() ?? 'http://localhost:4100';
}

async function proxy(request: Request, path: string): Promise<Response> {
  const incoming = new URL(request.url);
  const target = new URL(path, apiBaseUrl());
  target.search = incoming.search;

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

  let upstream: Response;
  try {
    const forwardHeaders = new Headers(request.headers);
    // The API needs the real client address for its logs.
    forwardHeaders.set('x-forwarded-host', incoming.host);

    upstream = await fetch(target, {
      method: request.method,
      headers: forwardHeaders,
      ...(hasBody ? { body: await request.arrayBuffer() } : {}),
      redirect: 'manual',
    });
  } catch (error) {
    return Response.json(
      {
        error: {
          code: 'api_unreachable',
          message: `the API at ${apiBaseUrl()} could not be reached`,
          details: (error as Error).message,
        },
      },
      { status: 502 },
    );
  }

  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') return;
    headers.set(key, value);
  });

  // The session cookie has to survive the proxy untouched, including the
  // attributes, so it is copied verbatim.
  const setCookie = upstream.headers.getSetCookie?.() ?? [];
  for (const cookie of setCookie) headers.append('set-cookie', cookie);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

type Context = { params: Promise<{ path: string[] }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const { path } = await context.params;
  return proxy(request, `/api/${path.join('/')}`);
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const { path } = await context.params;
  return proxy(request, `/api/${path.join('/')}`);
}

export async function PUT(request: Request, context: Context): Promise<Response> {
  const { path } = await context.params;
  return proxy(request, `/api/${path.join('/')}`);
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  const { path } = await context.params;
  return proxy(request, `/api/${path.join('/')}`);
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  const { path } = await context.params;
  return proxy(request, `/api/${path.join('/')}`);
}
