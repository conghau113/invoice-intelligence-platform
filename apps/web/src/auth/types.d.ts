import 'next-auth';
import 'next-auth/jwt';

declare module 'next-auth' {
  // Browser-visible session: deliberately has NO token fields.
  interface Session {
    tenant?: string;
    roles: string[];
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    accessToken?: string;
    refreshToken?: string;
    idToken?: string;
    expiresAt?: number;
    tenant?: string;
    roles?: string[];
  }
}
