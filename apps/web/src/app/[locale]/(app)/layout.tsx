import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import { getLocale, getTranslations } from 'next-intl/server';
import { getSession } from '@/auth/session';
import { StatePanel } from '@/components/common/state-panel';
import { AppShell } from '@/features/shell/app-shell';
import { forbiddenHintKey } from '@/features/shell/forbidden';
import { getMe } from '@/features/shell/me';
import { currentTenant } from '@/lib/api';
import { parseSidebarCollapsed, SIDEBAR_COOKIE } from '@/lib/sidebar';
import { parseTheme, THEME_COOKIE } from '@/lib/theme';

/** Every signed-in page lives under this layout: session guard + shell + who-am-I from the API. */
export default async function AppLayout({ children }: Readonly<{ children: ReactNode }>) {
  // Per-request: never prerender at build time (CI has no auth env).
  await connection();
  const locale = await getLocale();
  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  const jar = await cookies();
  const theme = parseTheme(jar.get(THEME_COOKIE)?.value);
  const sidebarCollapsed = parseSidebarCollapsed(jar.get(SIDEBAR_COOKIE)?.value);
  const shellProps = {
    theme,
    user: session.user ?? undefined,
    sidebarCollapsed,
    readOnly: process.env.DEMO_READ_ONLY === 'true',
  };
  const me = await getMe();
  if (me.kind === 'unauthorized') redirect(`/${locale}/login`);

  if (me.kind !== 'ok') {
    // The API refused or is down: show why, with no menu (nothing is known to be allowed).
    const t = await getTranslations('Shell');
    const forbidden = me.kind === 'forbidden';
    const tenant = await currentTenant();
    return (
      <AppShell {...shellProps} tenant={tenant} tenants={session.tenants}>
        <StatePanel
          kind="error"
          title={forbidden ? t('forbiddenTitle') : t('unavailableTitle')}
          description={forbidden ? t(forbiddenHintKey(me.code)) : t('unavailableHint')}
          action={
            forbidden && me.code ? (
              <code data-testid="error-code" className="text-xs text-muted-foreground">
                {/* Technical detail for support: the code and the tenant this request tried to use. */}
                {me.code} · X-Tenant: {tenant ?? '-'}
              </code>
            ) : undefined
          }
        />
      </AppShell>
    );
  }
  return (
    <AppShell {...shellProps} access={me.data} tenant={await currentTenant()}>
      {children}
    </AppShell>
  );
}
