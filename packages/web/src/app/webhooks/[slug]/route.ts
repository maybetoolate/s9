import { API_INTERNAL_URL, API_PUBLIC_URL } from '@/lib/api-url';

/**
 * The webhook proxy.
 *
 * The public intake endpoint belongs to the API, but proxying it through the
 * web app makes it convenient to try a delivery from the browser. The API
 * address is resolved when the request arrives, not at build time.
 */

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ slug: string }> };

async function proxy(request: Request, slug: string): Promise<Response> {
  const base = API_INTERNAL_URL() ?? API_PUBLIC_URL() ?? 'http://localhost:4100';
  const incoming = new URL(request.url);
  const target = new URL(`/webhooks/${slug}`, base);
  target.search = incoming.search;

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers: request.headers,
      ...(hasBody ? { body: await request.arrayBuffer() } : {}),
      redirect: 'manual',
    });
  } catch (error) {
    return Response.json(
      {
        error: {
          code: 'api_unreachable',
          message: `the API at ${base} could not be reached`,
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
  for (const cookie of upstream.headers.getSetCookie?.() ?? []) headers.append('set-cookie', cookie);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const { slug } = await context.params;
  return proxy(request, slug);
}

export async function GET(request: Request, context: Context): Promise<Response> {
  const { slug } = await context.params;
  return proxy(request, slug);
}
