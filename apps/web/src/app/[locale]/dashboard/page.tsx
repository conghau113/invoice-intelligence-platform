import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import { getLocale, getTranslations } from 'next-intl/server';
import { LanguageSwitcher } from '@/components/common/language-switcher';
import { Button } from '@/components/ui/button';
import { getSession } from '@/auth/session';

// Minimal landing page for T1.5; the real shell/menu is T1.7.
export default async function DashboardPage() {
  // Per-request page: never prerender at build time (CI has no auth env).
  await connection();
  const t = await getTranslations('Dashboard');
  const session = await getSession();
  if (!session) redirect(`/${await getLocale()}/login`);
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p data-testid="tenant">{session.tenant ?? '-'}</p>
      <form action="/api/auth/logout" method="post">
        <Button type="submit" data-testid="logout">
          {t('signOut')}
        </Button>
      </form>
      <LanguageSwitcher />
    </main>
  );
}
