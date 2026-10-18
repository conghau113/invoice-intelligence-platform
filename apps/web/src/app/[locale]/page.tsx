import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

// Server Component (no "use client"): rendered on the server, ships no JS of its own.
export default function HomePage() {
  const t = useTranslations();
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-2xl font-semibold">{t('Common.appName')}</h1>
      <Button>{t('Home.sample')}</Button>
    </main>
  );
}
