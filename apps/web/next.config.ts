import path from 'node:path';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  // Production image only (apps/web/Dockerfile sets NEXT_OUTPUT_STANDALONE=1, T4.7): the build
  // also writes .next/standalone, a server.js with only the node_modules it traces. Off elsewhere,
  // because `next start` (CI e2e) is not supported with standalone output. The tracing root is the
  // monorepo so workspace packages (contracts) and pnpm's symlinked store are traced too.
  ...(process.env.NEXT_OUTPUT_STANDALONE === '1'
    ? { output: 'standalone' as const, outputFileTracingRoot: path.join(__dirname, '../..') }
    : {}),
  // Same headers as Caddy sets on the demo (infra/prod/Caddyfile), so they hold wherever the web
  // runs (e2e, local). HSTS stays with Caddy: it only means something over https. The CSP is per
  // response (a nonce), so proxy.ts sets it (T7.4).
  // Next expects a promise here; nothing is awaited, so no async function (Sonar S7503).
  headers() {
    return Promise.resolve([
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ]);
  },
  // No `X-Powered-By: Next.js` (Caddy's `-Server` removes a different header).
  poweredByHeader: false,
  experimental: {
    // proxy.ts also runs on /api/*: Next buffers the request body for it (default 10MB) and
    // silently cuts what is over. A 10 MiB upload plus multipart framing must fit.
    proxyClientMaxBodySize: '11mb',
  },
};

export default withNextIntl(nextConfig);
