import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * No browser origin may call the REST API (T7.4, docs/architecture/SECURITY.md §8). Browsers only
 * talk to the web server, which calls the API from its own server with the user's token (BFF,
 * ADR 0006), and the demo's Caddy does not route to the API at all. `origin: false` writes no
 * Access-Control-Allow-* header, so a page on any other origin cannot read a response, and a
 * preflight finds no route (404), so a cross-origin call with a token or a JSON body is never
 * sent. The realtime socket checks `Origin` against its own allow-list (REALTIME_ALLOWED_ORIGINS,
 * T6.4); this does not touch it.
 */
export function applyCorsPolicy(app: NestExpressApplication): void {
  app.enableCors({ origin: false });
}
