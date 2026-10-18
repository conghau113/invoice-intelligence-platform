export function buildEndSessionUrl(opts: {
  issuer: string;
  clientId: string;
  idToken?: string;
  postLogoutRedirectUri: string;
}): string {
  const url = new URL(`${opts.issuer}/protocol/openid-connect/logout`);
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('post_logout_redirect_uri', opts.postLogoutRedirectUri);
  if (opts.idToken) url.searchParams.set('id_token_hint', opts.idToken);
  return url.toString();
}

/** Logout is state-changing: accept only same-origin POSTs (logout-CSRF). */
export function isSameOrigin(origin: string | null, appUrl: string): boolean {
  return origin !== null && origin === new URL(appUrl).origin;
}
