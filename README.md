# MCP App HTML Proxy

A secure, sandboxed proxy for hosting MCP Apps (Model Context Protocol interactive UIs). This project implements the double-iframe architecture required by SEP-1865 for safely rendering third-party HTML widgets in MCP-enabled applications.

🔗 **Public Instance**: https://mcp-app-proxy.botdojo.com/

📖 **Open Source**: https://github.com/botdojo-ai/mcp-app-proxy

## What is This?

MCP Apps are interactive UI components that render inside chat conversations (defined by [SEP-1865](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/1865)). For security, they must run in a sandboxed environment isolated from the host application.

This proxy provides that secure sandbox using a **double-iframe architecture**:

```
┌─────────────────────────────────────────────┐
│  Host (Your App)                            │
│  origin: https://app.example.com            │
│                                             │
│  ┌───────────────────────────────────────┐ │
│  │ Outer Iframe (This Proxy)             │ │
│  │ origin: https://mcp-app-proxy.com     │ │
│  │ src: /{flowId}/?url=ui://resource     │ │
│  │                                        │ │
│  │  ┌──────────────────────────────────┐ │ │
│  │  │ Inner Iframe (MCP App)           │ │ │
│  │  │ srcdoc: <HTML with CSP>          │ │ │
│  │  │ sandbox: allow-scripts           │ │ │
│  │  │          allow-same-origin       │ │ │
│  │  │                                  │ │ │
│  │  │  [Your MCP App runs here]        │ │ │
│  │  └──────────────────────────────────┘ │ │
│  └───────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

## Key Features

✅ **Security Isolation**: Different origin prevents access to host cookies, localStorage, etc.
✅ **CSP Enforcement**: Injects Content Security Policy into HTML before rendering
✅ **Message Queueing**: Buffers messages until MCP App signals ready
✅ **Smart Caching**: IndexedDB + API caching to avoid re-fetching HTML
✅ **HTTP(S) Passthrough**: External URLs load directly without proxying
✅ **Spec Compliant**: Implements SEP-1865 requirements

## How It Works

### 1. Host Creates Proxy Iframe

```typescript
import { buildMcpProxyUrl } from '@botdojo/chat-sdk';

const proxyUrl = buildMcpProxyUrl({
  flowId: 'user-123-flow-abc',      // Unique cache namespace
  resource: 'ui://my-app/widget',    // MCP resource URI
  origin: 'https://mcp-app-proxy.botdojo.com',
  noCache: false,
});

// proxyUrl: https://mcp-app-proxy.botdojo.com/user-123-flow-abc/?url=ui%3A%2F%2Fmy-app%2Fwidget
```

### 2. Proxy Initialization Flow

```
1. Proxy page loads
2. Checks cache (IndexedDB + API) for HTML
3a. Cache HIT:
   - Loads HTML from cache into inner iframe
   - Sends: ui/notifications/sandbox-ready { loadedFromCache: true }
3b. Cache MISS:
   - Sends: ui/notifications/sandbox-ready { loadedFromCache: false }
   - Host responds: ui/notifications/sandbox-resource-ready { html, csp, sandbox }
   - Proxy injects CSP and loads HTML
4. Inner iframe sends: ui/notifications/client-ready
5. Proxy flushes queued messages to inner iframe
6. All subsequent messages forwarded transparently
```

### 3. Message Forwarding

The proxy transparently forwards JSON-RPC messages between host and MCP App:

- **Host → MCP App**: Tool arguments, initialization data, progress updates
- **MCP App → Host**: Messages to chat, tool calls, link requests, state persistence

## API Reference

### URL Structure

```
https://mcp-app-proxy.botdojo.com/{flowId}/?url={resourceUrl}&noCache={boolean}
```

**Path Parameters:**
- `flowId` - Unique identifier for cache namespace (e.g., user ID + conversation ID)

**Query Parameters:**
- `url` - Encoded MCP resource URI (e.g., `ui://my-app/widget` or `https://example.com/app.html`)
- `noCache` - (Optional) Set to `true` or `1` to disable caching

### JSON-RPC Messages

#### Proxy → Host

**`ui/notifications/sandbox-ready`**
```json
{
  "jsonrpc": "2.0",
  "method": "ui/notifications/sandbox-ready",
  "params": {
    "flowId": "user-123-flow-abc",
    "resource": "ui://my-app/widget",
    "loadedFromCache": true
  }
}
```

#### Host → Proxy

**`ui/notifications/sandbox-resource-ready`** (only if cache miss)
```json
{
  "jsonrpc": "2.0",
  "method": "ui/notifications/sandbox-resource-ready",
  "params": {
    "html": "<!DOCTYPE html><html>...",
    "csp": "default-src 'none'; connect-src https://api.example.com",
    "sandbox": "allow-scripts allow-same-origin",
    "resource": "ui://my-app/widget"
  }
}
```

#### MCP App → Proxy (Internal)

**`ui/notifications/client-ready`**
```json
{
  "jsonrpc": "2.0",
  "method": "ui/notifications/client-ready",
  "params": {}
}
```

This message is **not forwarded to the host**. It signals the proxy to flush queued messages.

## Caching

The proxy implements a two-tier caching system:

### 1. In-Memory Cache (IndexedDB)
- Key format: `{flowId}::{resourceUri}`
- Stores HTML content for fast retrieval
- Cleared on browser refresh (session-scoped)

### 2. Persistent Cache (API)
- Backend API stores HTML keyed by flow + resource
- Survives browser refreshes
- Cache API: `/api/cache/get?resource={resource}&namespace={flowId}`

### Cache Invalidation

**Development Mode** - Disable caching:
```typescript
// Option 1: Tool metadata
_meta: {
  'botdojo/no-cache': true,
  ui: { resourceUri: 'ui://my-app' }
}

// Option 2: Proxy URL
buildMcpProxyUrl({ flowId, resource, noCache: true })
```

**Cache Busting** - Force refresh:
```typescript
// Change the resource URI
resourceUri: 'ui://my-app?v=2'

// Or use cache_buster query param (legacy)
resourceUri: 'ui://my-app?cache_buster=' + Date.now()
```

## Content Security Policy (CSP)

The proxy enforces CSP to restrict MCP App capabilities:

### Default CSP
```
default-src 'none';
script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:;
style-src 'self' 'unsafe-inline' blob:;
img-src 'self' data: blob:;
font-src 'self' data: blob:;
connect-src *;
media-src 'self' data: blob:;
frame-src *;
object-src 'none';
base-uri 'self';
form-action 'none'
```

### Custom CSP

Specify allowed domains in resource metadata:

```typescript
{
  uri: 'ui://my-app/widget',
  mimeType: 'text/html;profile=mcp-app',
  _meta: {
    ui: {
      resourceUri: 'ui://my-app/widget',
      csp: {
        connectDomains: ['https://api.example.com', 'wss://ws.example.com'],
        resourceDomains: ['https://cdn.example.com', 'https://*.cloudfront.net']
      }
    }
  },
  getContent: async () => ({ /* HTML */ })
}
```

The proxy will build and inject:
```html
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src https://api.example.com wss://ws.example.com; img-src https://cdn.example.com https://*.cloudfront.net; ...">
```

## HTTP(S) Passthrough

For performance, external HTTPS URLs bypass the proxy entirely:

```typescript
// This loads directly in the iframe (no HTML fetching/injection)
resourceUri: 'https://widgets.example.com/product-card.html'

// Proxy sets: iframe.src = 'https://widgets.example.com/product-card.html'
```

The proxy still:
- Forwards JSON-RPC messages between host and app
- Sends `ui/notifications/sandbox-ready` to signal readiness
- Queues messages until `client-ready` received

## Development

### Running Locally

```bash
# Install dependencies
npm install

# Run dev server
npm run dev

# Proxy available at http://localhost:3000
```

### Testing with BotDojo SDK

```typescript
import { buildMcpProxyUrl } from '@botdojo/chat-sdk';

const proxyUrl = buildMcpProxyUrl({
  flowId: 'test-123',
  resource: 'ui://my-app/widget',
  origin: 'http://localhost:3000',  // Local proxy
  noCache: true,
});
```

### Project Structure

```
sdk-mcp-app-html-proxy/
├── pages/
│   └── [id]/
│       └── index.tsx          # Main proxy implementation
├── src/
│   └── utils/
│       └── cache.ts           # IndexedDB + API caching
├── public/                    # Static assets
├── package.json
├── tsconfig.json
└── next.config.js
```

## Integration Example

Using the proxy with BotDojo Chat SDK:

```typescript
import { BotDojoChat } from '@botdojo/chat-sdk';

function MyApp() {
  return (
    <BotDojoChat
      apiKey="your-api-key"
      cacheKey="user-123-flow-abc"  // Used as flowId for proxy
      modelContext={{
        tools: [
          {
            name: 'show_widget',
            description: 'Display interactive widget',
            inputSchema: { /* ... */ },
            _meta: {
              ui: {
                resourceUri: 'ui://my-app/widget',
                csp: {
                  connectDomains: ['https://api.example.com']
                }
              }
            },
            execute: async (args) => {
              return [{ type: 'text', text: 'Widget displayed' }];
            }
          }
        ],
        resources: [
          {
            uri: 'ui://my-app/widget',
            name: 'My Widget',
            mimeType: 'text/html;profile=mcp-app',
            getContent: async () => ({
              uri: 'ui://my-app/widget',
              mimeType: 'text/html;profile=mcp-app',
              text: '<html>...</html>'  // Your MCP App HTML
            })
          }
        ]
      }}
    />
  );
}
```

## Security Considerations

### Why Different Origin Matters

The proxy runs on a different origin (e.g., `https://mcp-app-proxy.botdojo.com`) than your host app (e.g., `https://app.example.com`). This prevents MCP Apps from:

- Accessing host cookies or localStorage
- Making authenticated requests on behalf of the user
- Reading sensitive data from the host DOM
- Executing arbitrary code in the host context

### Message Validation

The proxy forwards **all messages** between host and MCP App. The host is responsible for:

- Validating tool call requests before execution
- Sanitizing user messages before displaying
- Prompting user before opening external links
- Validating state persistence data

### CSP Limitations

- `unsafe-inline` and `unsafe-eval` are enabled for `script-src` to support common widget patterns
- `connect-src *` allows fetch to any domain by default (override with `csp.connectDomains`)
- Host should validate external resource URLs in `csp.resourceDomains`

## Deployment

### Hosting Your Own Proxy

1. **Deploy to Vercel/Netlify**:
   ```bash
   npm run build
   # Deploy dist/ to your hosting provider
   ```

2. **Configure CORS** (if needed):
   ```typescript
   // next.config.js
   module.exports = {
     async headers() {
       return [{
         source: '/:path*',
         headers: [
           { key: 'Access-Control-Allow-Origin', value: '*' },
         ],
       }];
     },
   };
   ```

3. **Set Environment Variables**:
   ```env
   CACHE_API_URL=https://your-cache-api.com
   ```

4. **Update SDK Configuration**:
   ```typescript
   buildMcpProxyUrl({
     origin: 'https://your-proxy.com',
     // ...
   })
   ```

## Related Projects

- **[mcp-app-view](https://github.com/botdojo-ai/mcp-app-view)** - React hooks and utilities for building MCP Apps
- **[BotDojo Chat SDK](https://github.com/botdojo-ai/botdojo-sdk)** - Full SDK for building AI agents with MCP support

## License

MIT

## Contributing

Contributions welcome! Please open an issue or PR on GitHub.

---

Built with ❤️ by the BotDojo team
