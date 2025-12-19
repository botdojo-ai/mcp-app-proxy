import type { NextRequest } from 'next/server';

export const config = {
  runtime: 'edge',
};

const CACHE_NAME = 'mcp-html-proxy';
const memoryCache = new Map<string, Response>();

type CacheLike = {
  match: (request: RequestInfo | URL) => Promise<Response | undefined>;
  put: (request: RequestInfo | URL, response: Response) => Promise<void>;
};

async function getCache(): Promise<CacheLike> {
  if (typeof caches !== 'undefined') {
    return caches.open(CACHE_NAME);
  }
  // Dev/server fallback where Web Cache API is unavailable.
  return {
    async match(request: RequestInfo | URL) {
      const key = typeof request === 'string' ? request : request.toString();
      return memoryCache.get(key);
    },
    async put(request: RequestInfo | URL, response: Response) {
      const key = typeof request === 'string' ? request : request.toString();
      memoryCache.set(key, response);
    },
  };
}

function getCacheKey(req: NextRequest): { cacheKey: string | null; cacheUrl: string } {
  const url = new URL(req.url);
  const segments = url.pathname.split('/');
  const rawSegment = segments.pop() || segments.pop() || null;
  // Decode once to undo the double-encoding used on the client (keeps slashes intact)
  let cacheKey: string | null = null;
  if (rawSegment) {
    try {
      cacheKey = decodeURIComponent(rawSegment);
    } catch {
      cacheKey = rawSegment;
    }
  }
  const cacheUrl = `${url.origin}/api/cache/${rawSegment ? encodeURIComponent(rawSegment) : ''}`;
  return { cacheKey, cacheUrl };
}

async function readFromCache(cacheUrl: string): Promise<Response | null> {
  const cache = await getCache();
  const cached = await cache.match(cacheUrl);
  // Clone to avoid locking body for future callers
  return cached ? cached.clone() : null;
}

async function writeToCache(cacheUrl: string, html: string): Promise<Response> {
  const cache = await getCache();
  const response = new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
  await cache.put(cacheUrl, response.clone());
  return response;
}

export default async function handler(req: NextRequest) {
  const { cacheKey, cacheUrl } = getCacheKey(req);
  if (!cacheKey) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing cache key' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (req.method === 'GET') {
    const cached = await readFromCache(cacheUrl);
    if (!cached) {
      return new Response('Not Found', { status: 404 });
    }
    return cached;
  }

  if (req.method === 'POST') {
    const contentType = req.headers.get('content-type') || '';
    let html: string | null = null;

    if (contentType.includes('application/json')) {
      try {
        const body = await req.json();
        if (typeof body?.html === 'string') {
          html = body.html;
        }
      } catch {
        // Fall through to plain text handling
      }
    }

    if (html === null) {
      const bodyText = await req.text();
      html = bodyText || null;
    }

    if (!html) {
      return new Response(JSON.stringify({ ok: false, error: 'Missing HTML body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    await writeToCache(cacheUrl, html);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(`Method ${req.method} Not Allowed`, {
    status: 405,
    headers: { Allow: 'GET, POST' },
  });
}
