'use client';

import { signIn } from 'next-auth/react';
import { safeAlias, safePath } from '@/auth/login-params';
import { Button } from '@/components/ui/button';

// TODO(T1.6): i18n
export function LoginButton({
  callbackUrl,
  tenant,
}: Readonly<{ callbackUrl?: string; tenant?: string }>) {
  const alias = safeAlias(tenant);
  return (
    <Button
      data-testid="login"
      onClick={() =>
        signIn(
          'keycloak',
          { callbackUrl: safePath(callbackUrl) },
          alias ? { scope: `openid organization:${alias}` } : undefined,
        )
      }
    >
      Sign in
    </Button>
  );
}
