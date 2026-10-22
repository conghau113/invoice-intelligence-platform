import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  experimental: {
    // proxy.ts also runs on /api/*: Next buffers the request body for it (default 10MB) and
    // silently cuts what is over. A 10 MiB upload plus multipart framing must fit.
    proxyClientMaxBodySize: '11mb',
  },
};

export default withNextIntl(nextConfig);
