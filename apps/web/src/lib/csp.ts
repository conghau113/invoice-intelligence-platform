// Content-Security-Policy for every page (T7.4, docs/architecture/SECURITY.md §8). proxy.ts builds
// one per request with a fresh nonce; Next reads the nonce from the request's CSP header and puts it
// on its own <script> tags, so only scripts the server rendered for this response run.

export type CspInput = {
  nonce: string;
  dev: boolean;
  /** Public origin of the realtime socket (the API), when realtime is on. */
  realtimeUrl: string | null;
  /** Keycloak issuer URL: sign-in and sign-out end in a redirect there. */
  issuerUrl: string | undefined;
  /** The web's own public URL; https adds upgrade-insecure-requests. */
  appUrl: string | undefined;
};

function origin(raw: string | null | undefined): URL | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** 16 random bytes, base64: unguessable and new for every response. */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCodePoint(...bytes));
}

export function contentSecurityPolicy(input: CspInput): string {
  const realtime = origin(input.realtimeUrl);
  const issuer = origin(input.issuerUrl);
  const https = origin(input.appUrl)?.protocol === 'https:';

  // The socket opens ws(s):// on the API's origin; list both schemes rather than rely on how a
  // browser maps an http source onto ws.
  const connect = ["'self'"];
  if (realtime) {
    connect.push(
      realtime.origin,
      `${realtime.protocol === 'https:' ? 'wss' : 'ws'}://${realtime.host}`,
    );
  }

  const directives: Array<[string, ...string[]]> = [
    ['default-src', "'self'"],
    // 'strict-dynamic': a script with the nonce may load the chunks it needs (next/dynamic, the
    // pdf.js chunk); a host allow-list is then ignored by CSP3 browsers. React needs eval in dev only.
    [
      'script-src',
      "'self'",
      `'nonce-${input.nonce}'`,
      "'strict-dynamic'",
      ...(input.dev ? ["'unsafe-eval'"] : []),
    ],
    // React renders style="" attributes (progress bars, column widths), which only 'unsafe-inline'
    // allows; a nonce here would make browsers ignore 'unsafe-inline'. Styles cannot run code.
    ['style-src', "'self'", "'unsafe-inline'"],
    // blob: the review screen shows an image from memory; data: small inline icons.
    ['img-src', "'self'", 'blob:', 'data:'],
    // next/font serves the fonts from our own origin.
    ['font-src', "'self'"],
    ['connect-src', ...connect],
    // pdf.js runs its worker from our own origin (no CDN, T3.4).
    ['worker-src', "'self'"],
    ['object-src', "'none'"],
    ['base-uri', "'none'"],
    // Chrome checks form-action on the redirects after a submit as well: sign-out posts to us and
    // is redirected to Keycloak's end-session endpoint.
    ['form-action', "'self'", ...(issuer ? [issuer.origin] : [])],
    // The page is never framed (clickjacking); X-Frame-Options says the same for old browsers.
    ['frame-ancestors', "'none'"],
  ];
  if (https) directives.push(['upgrade-insecure-requests']);
  return directives.map((d) => d.join(' ')).join('; ');
}
