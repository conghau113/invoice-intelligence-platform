import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { LanguageSwitcher } from '@/components/common/language-switcher';
import { ThemeToggle } from '@/components/common/theme-toggle';
import { Button } from '@/components/ui/button';
import type { Theme } from '@/lib/theme';
import { visibleNavItems } from './nav-items';
import { MobileMenu } from './mobile-menu';
import { SidebarNav, type SidebarEntry } from './sidebar-nav';
import { TenantSwitcher } from './tenant-switcher';

const ROLES = ['tenant_admin', 'accountant', 'viewer'] as const;
type Role = (typeof ROLES)[number];

interface Props {
  children: ReactNode;
  theme: Theme;
  /** From GET /auth/me; undefined when the API refused or is down (shell shows no menu). */
  access?: { permissions: readonly string[]; roles: readonly string[]; tenants: readonly string[] };
  tenant?: string;
  /** Tenants to offer when `access` is missing (API refused): the user must still be able to switch. */
  tenants?: readonly string[];
}

/** Sidebar + header around every signed-in page. Server Component; only small parts are client. */
export async function AppShell({ children, theme, access, tenant, tenants }: Readonly<Props>) {
  const t = await getTranslations('Shell');
  const tNav = await getTranslations('Nav');
  const tRole = await getTranslations('Role');
  const entries: SidebarEntry[] = visibleNavItems(access?.permissions ?? []).map((i) => ({
    id: i.id,
    href: i.href,
    label: tNav(i.id),
  }));
  const switchable = access?.tenants ?? tenants;
  const nav = <SidebarNav items={entries} label={t('mainMenu')} />;
  return (
    <div className="min-h-screen bg-background md:grid md:grid-cols-[16rem_1fr]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2"
      >
        {t('skipToContent')}
      </a>
      <aside className="hidden border-r border-sidebar-border bg-sidebar p-4 md:block">
        <p className="mb-4 px-3 text-sm font-semibold text-sidebar-primary">{t('appName')}</p>
        {nav}
      </aside>
      <div className="flex min-w-0 flex-col">
        <header className="flex flex-wrap items-center gap-3 border-b bg-card px-4 py-2">
          <MobileMenu label={t('menu')}>
            <SidebarNav items={entries} label={t('mainMenu')} testIdPrefix="mobile-" />
          </MobileMenu>
          {tenant !== undefined && switchable && (
            <TenantSwitcher tenants={switchable} current={tenant} />
          )}
          <div className="ml-auto flex items-center gap-2">
            {access && access.roles.length > 0 && (
              <span data-testid="roles" className="hidden text-sm text-muted-foreground sm:inline">
                {access.roles
                  .filter((r): r is Role => ROLES.includes(r as Role))
                  .map((r) => tRole(r))
                  .join(', ')}
              </span>
            )}
            <LanguageSwitcher />
            <ThemeToggle initial={theme} />
            <form action="/api/auth/logout" method="post">
              <Button type="submit" variant="outline" data-testid="logout">
                {t('signOut')}
              </Button>
            </form>
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-(--content-max) p-4 md:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
