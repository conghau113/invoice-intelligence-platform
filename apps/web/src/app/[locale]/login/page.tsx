import { getTranslations } from 'next-intl/server';
import { LanguageSwitcher } from '@/components/common/language-switcher';
import { LoginButton } from './login-button';

export default async function LoginPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ callbackUrl?: string; tenant?: string }>;
}>) {
  const { callbackUrl, tenant } = await searchParams;
  const t = await getTranslations('Common');
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-2xl font-semibold">{t('appName')}</h1>
      <LoginButton callbackUrl={callbackUrl} tenant={tenant} />
      <LanguageSwitcher />
    </main>
  );
}
