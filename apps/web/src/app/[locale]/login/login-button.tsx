'use client';

import { useTranslations } from 'next-intl';
import { signIn } from 'next-auth/react';
import { safeAlias, safePath } from '@/auth/login-params';
import { Button } from '@/components/ui/button';

export function LoginButton({
  callbackUrl,
  tenant,
}: Readonly<{ callbackUrl?: string; tenant?: string }>) {
  const t = useTranslations('Login');
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
      {t('signIn')}
    </Button>
  );
}
