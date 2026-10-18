import { getTranslations } from 'next-intl/server';
import { getMe } from '@/features/shell/me';
import { currentTenant } from '@/lib/api';

// Placeholder landing page: shows what the API says about the caller (the layout already
// handled sign-in and API errors). Business pages arrive in M2.
export default async function DashboardPage() {
  const t = await getTranslations('Dashboard');
  const me = await getMe();
  if (me.kind !== 'ok') return null;
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <dl className="grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
        <dt className="text-muted-foreground">{t('tenant')}</dt>
        <dd data-testid="dashboard-tenant" className="font-mono">
          {await currentTenant()}
        </dd>
        <dt className="text-muted-foreground">{t('tenantId')}</dt>
        <dd data-testid="dashboard-tenant-id" className="font-mono">
          {me.data.tenantId}
        </dd>
        <dt className="text-muted-foreground">{t('permissions')}</dt>
        <dd className="font-mono">{me.data.permissions.join(', ') || '-'}</dd>
      </dl>
    </section>
  );
}
