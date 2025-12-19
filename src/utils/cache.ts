const htmlCache = new Map<string, string>();
const CACHE_ENDPOINT_BASE = '/api/cache';

function encodeCacheKey(key: string): string {
  // Double-encode to keep slashes/colons intact through Next routing
  return encodeURIComponent(encodeURIComponent(key));
}

export function hasCachedHtml(key: string): boolean {
  return htmlCache.has(key);
}

export function getCachedHtml(key: string): string | undefined {
  return htmlCache.get(key);
}

export function setCachedHtml(key: string, html: string): void {
  htmlCache.set(key, html);
}

function buildCachePath(key: string, namespace?: string): string {
  const namespacedKey = namespace ? `${namespace}::${key}` : key;
  return `${CACHE_ENDPOINT_BASE}/${encodeCacheKey(namespacedKey)}`;
}

export async function fetchCachedHtmlFromApi(key: string, namespace?: string): Promise<string | null> {
  if (typeof fetch !== 'function') return null;
  try {
    const res = await fetch(buildCachePath(key, namespace), { method: 'GET' });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function persistCachedHtmlToApi(key: string, html: string, namespace?: string): Promise<void> {
  if (typeof fetch !== 'function') return;
  try {
    await fetch(buildCachePath(key, namespace), {
      method: 'POST',
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: html,
    });
  } catch {
    // Best-effort; ignore network failures
  }
}
