'use client';

import { useTranslations } from 'next-intl';
import { signIn } from 'next-auth/react';
import { safePath } from '@/auth/login-params';
import { Button } from '@/components/ui/button';

export function LoginButton({ callbackUrl }: Readonly<{ callbackUrl?: string }>) {
  const t = useTranslations('Login');
  return (
    <Button
      data-testid="login"
      onClick={() => signIn('keycloak', { callbackUrl: safePath(callbackUrl) })}
    >
      {t('signIn')}
    </Button>
  );
}
