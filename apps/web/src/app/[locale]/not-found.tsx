import { getTranslations } from 'next-intl/server';
import { StatePanel } from '@/components/common/state-panel';
import { Link } from '@/i18n/navigation';

// Translated 404 for every URL under /vi or /en (see [...rest]/page.tsx).
export default async function LocaleNotFound() {
  const t = await getTranslations('NotFound');
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center p-4">
      <StatePanel
        kind="empty"
        title={t('title')}
        description={t('hint')}
        action={
          <Link href="/dashboard" className="text-sm font-medium underline">
            {t('home')}
          </Link>
        }
      />
    </main>
  );
}
