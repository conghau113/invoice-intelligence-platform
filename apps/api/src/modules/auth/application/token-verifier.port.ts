export type TokenClaims = Readonly<Record<string, unknown>>;

export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');

export interface TokenVerifier {
  /** Resolves with the claims of a valid token; rejects for ANY invalid token (reason not exposed). */
  verify(token: string): Promise<TokenClaims>;
}
