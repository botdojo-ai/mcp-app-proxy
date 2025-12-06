import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect, useRef } from 'react';
import {
  fetchCachedHtmlFromApi,
  getCachedHtml,
  persistCachedHtmlToApi,
  setCachedHtml,
} from '../../src/utils/cache';

const DEFAULT_SANDBOX = 'allow-scripts allow-same-origin';
const DEFAULT_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline' blob:; img-src 'self' data: blob:; font-src 'self' data: blob:; connect-src *; media-src 'self' data: blob:; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'";

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function injectIntoHead(html: string, headContent: string): string {
  if (!headContent) return html;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>\n${headContent}\n`);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html([^>]*)>/i, `<html$1>\n<head>\n${headContent}\n</head>`);
  }
  return `<head>\n${headContent}\n</head>\n${html}`;
}

function ensureCspMeta(html: string, csp: string, overwrite = false): string {
  if (!html || !csp) return html;
  const metaTag = `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttr(csp)}">`;
  const cspRegex = /<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/i;
  const hasCsp = cspRegex.test(html);
  if (hasCsp && !overwrite) {
    return html;
  }
  if (hasCsp && overwrite) {
    return html.replace(cspRegex, metaTag);
  }
  return injectIntoHead(html, metaTag);
}

/**
 * MCP App HTML Proxy
 *
 * Usage: /{id}/?url=<encodeURIComponent(resourceUrl)>
 *
 * Example:
 *   const proxyUrl = `https://mcp-proxy.example.com/${flowId}/?url=${encodeURIComponent('app://my-app/index.html')}`;
 */
export default function SandboxProxyPage() {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);

  // Get path param (id/flowId) and query param (url)
  const flowId = typeof router.query.id === 'string' ? router.query.id : null;
  const resourceUrl =
    typeof router.query.url === 'string' ? router.query.url : null;
  const cacheNamespace = flowId || 'default';
  const namespacedKey = resourceUrl ? `${cacheNamespace}::${resourceUrl}` : null;

  useEffect(() => {
    if (!router.isReady) return;
    if (typeof window === 'undefined') return;
    const container = containerRef.current;
    if (!container) return;

    // Only meaningful inside an iframe; warn if opened directly.
    if (window.self === window.top) {
      console.warn(
        '[mcp-proxy] This proxy page is intended to run inside an iframe.',
      );
    }
    const inner = document.createElement('iframe');
    inner.style.width = '100%';
    inner.style.height = '100%';
    inner.style.border = 'none';
    inner.style.padding = '0';
    inner.style.margin = '0';
    inner.setAttribute('sandbox', DEFAULT_SANDBOX);
    container.appendChild(inner);

    const handleMessage = (event: MessageEvent) => {
      if (event.source === window.parent) {
        const data: any = event.data;
        if (data && data.method === 'ui/notifications/sandbox-resource-ready') {
          const { html, sandbox, resource, csp } = data.params || {};
          const sandboxValue = typeof sandbox === 'string' && sandbox.trim() ? sandbox : DEFAULT_SANDBOX;
          inner.setAttribute('sandbox', sandboxValue);
          if (typeof html === 'string') {
            const safeHtml = ensureCspMeta(html, csp || DEFAULT_CSP, true);
            inner.srcdoc = safeHtml;
            const cacheKey = typeof resource === 'string' ? `${cacheNamespace}::${resource}` : namespacedKey;
            if (cacheKey) {
              setCachedHtml(cacheKey, safeHtml);
              void persistCachedHtmlToApi(cacheKey, safeHtml, cacheNamespace);
            }
          }
        } else if (inner.contentWindow) {
          inner.contentWindow.postMessage(data, '*');
        }
      } else if (event.source === inner.contentWindow) {
        window.parent.postMessage(event.data, '*');
      }
    };

    window.addEventListener('message', handleMessage);
    // Advertise readiness to the parent so it can send HTML.
    window.parent?.postMessage(
      {
        jsonrpc: '2.0',
        method: 'ui/notifications/sandbox-ready',
        params: {
          flowId: flowId || undefined,
          resource: resourceUrl || undefined,
        },
      },
      '*',
    );

    // Check if URL is HTTP(S) - if so, fetch directly; otherwise use RPC chain
    const isHttpUrl = (uri: string): boolean => {
      try {
        const url = new URL(uri);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    };

    // Try local + server-side cache first; if missing, fetch directly or ask parent for HTML.
    const primeIframeFromCache = async () => {
      if (!resourceUrl || !namespacedKey) return false;

      // Skip cache if URL contains cache_buster
      if (resourceUrl.includes('cache_buster')) {
        return false;
      }

      const inMemory = getCachedHtml(namespacedKey);
      if (inMemory) {
        inner.srcdoc = ensureCspMeta(inMemory, DEFAULT_CSP);
        return true;
      }

      const cachedHtml = await fetchCachedHtmlFromApi(resourceUrl, cacheNamespace);
      if (cachedHtml) {
        setCachedHtml(namespacedKey, cachedHtml);
        inner.srcdoc = ensureCspMeta(cachedHtml, DEFAULT_CSP);
        return true;
      }

      return false;
    };

    void primeIframeFromCache().then(async (found) => {
      if (!resourceUrl || found) return;

      // For HTTP(S) URLs, fetch directly from the proxy
      if (isHttpUrl(resourceUrl)) {
        try {
          console.log('[mcp-proxy] Fetching HTTP(S) URL directly:', resourceUrl);
          const response = await fetch(resourceUrl);
          if (!response.ok) {
            console.error('[mcp-proxy] Failed to fetch URL:', response.statusText);
            return;
          }
          const html = await response.text();
          const safeHtml = ensureCspMeta(html, DEFAULT_CSP);
          inner.srcdoc = safeHtml;
          if (namespacedKey) {
            setCachedHtml(namespacedKey, safeHtml);
            void persistCachedHtmlToApi(resourceUrl, safeHtml, cacheNamespace);
          }
          console.log('[mcp-proxy] Successfully fetched and cached HTML');
        } catch (error) {
          console.error('[mcp-proxy] Error fetching URL:', error);
        }
        return;
      }

      // For non-HTTP(S) URLs (app://, mcp://, etc.), use RPC chain
      window.parent?.postMessage(
        {
          jsonrpc: '2.0',
          method: 'ui/requests/sandbox-resource',
          params: {
            flowId: flowId || undefined,
            resource: resourceUrl,
          },
        },
        '*',
      );
    });

    return () => {
      window.removeEventListener('message', handleMessage);
      if (inner.parentElement) {
        inner.parentElement.removeChild(inner);
      }
    };
  }, [router.isReady, flowId, resourceUrl]);

  return (
    <>
      <Head>
        <title>MCP App HTML Proxy</title>
        <meta charSet="utf-8" />
        {/* Default CSP for the proxy shell (inner iframe gets its own CSP injected) */}
        <meta httpEquiv="Content-Security-Policy" content={DEFAULT_CSP} />
        <style>{`
          html, body, #__next {
            margin: 0;
            padding: 0;
            height: 100%;
            width: 100%;
            overflow: hidden;
          }
          body {
            display: flex;
            flex-direction: column;
          }
          * { box-sizing: border-box; }
        `}</style>
      </Head>
      <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
    </>
  );
}
