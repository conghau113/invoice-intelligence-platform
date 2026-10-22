import { FileText } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { InfoBanner } from '@/components/common/info-banner';
import { LanguageSwitcher } from '@/components/common/language-switcher';
import { ThemeToggle } from '@/components/common/theme-toggle';
import { Button } from '@/components/ui/button';
import type { Theme } from '@/lib/theme';
import { initialsOf } from '@/lib/user-display';
import { AppSidebar } from './app-sidebar';
import { groupedNavItems } from './nav-items';
import { MobileMenu } from './mobile-menu';
import { SidebarNav, type SidebarGroup } from './sidebar-nav';
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
  /** Who is signed in, from the session (shown in the top bar). */
  user?: { name?: string | null; email?: string | null };
  sidebarCollapsed?: boolean;
  /** Show the read-only notice (DEMO_READ_ONLY). It informs; the API is what refuses writes. */
  readOnly?: boolean;
}

/**
 * The shell of every signed-in page (docs/ui/UI_LAYOUT_SPEC.md): it is exactly as tall as the
 * window and never scrolls itself. Top bar on top; below it the sidebar and the main area side by
 * side. Main fills what is left, so a page decides nothing about the layout around it.
 * Server Component; only the parts that need state or the router are client components.
 */
export async function AppShell({
  children,
  theme,
  access,
  tenant,
  tenants,
  user,
  sidebarCollapsed = false,
  readOnly = false,
}: Readonly<Props>) {
  const t = await getTranslations('Shell');
  const tNav = await getTranslations('Nav');
  const tRole = await getTranslations('Role');
  const groups: SidebarGroup[] = groupedNavItems(access?.permissions ?? []).map((g) => ({
    id: g.id,
    label: tNav(`groups.${g.id}`),
    items: g.items.map((i) => ({ id: i.id, href: i.href, label: tNav(i.id) })),
  }));
  const switchable = access?.tenants ?? tenants;
  const roles = (access?.roles ?? [])
    .filter((r): r is Role => ROLES.includes(r as Role))
    .map((r) => tRole(r))
    .join(', ');
  const displayName = user?.name?.trim() || user?.email || t('user');
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2"
      >
        {t('skipToContent')}
      </a>
      <header
        data-testid="topbar"
        className="flex min-h-(--topbar-height) min-w-0 flex-none flex-wrap items-center gap-x-3 gap-y-2 border-b border-sidebar-border bg-sidebar px-4 py-2"
      >
        <MobileMenu label={t('menu')}>
          <SidebarNav groups={groups} label={t('mainMenu')} testIdPrefix="mobile-" />
        </MobileMenu>
        <div className="flex flex-none items-center gap-2" data-testid="brand">
          <FileText aria-hidden className="size-5 text-sidebar-primary" />
          <span className="hidden text-sm font-semibold text-sidebar-primary sm:inline">
            {t('appName')}
          </span>
        </div>
        {tenant !== undefined && switchable && (
          <TenantSwitcher tenants={switchable} current={tenant} />
        )}
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <LanguageSwitcher />
          <ThemeToggle initial={theme} />
          <div className="flex min-w-0 items-center gap-2" role="group" aria-label={t('userMenu')}>
            <span
              aria-hidden
              data-testid="avatar"
              className="flex size-8 flex-none items-center justify-center rounded-full bg-nav-active text-xs font-semibold text-nav-active-foreground"
            >
              {initialsOf(user?.name, user?.email)}
            </span>
            <span className="hidden min-w-0 flex-col leading-tight sm:flex">
              <span data-testid="user-name" className="truncate text-sm font-medium">
                {displayName}
              </span>
              {roles && (
                <span data-testid="roles" className="truncate text-xs text-muted-foreground">
                  {roles}
                </span>
              )}
            </span>
          </div>
          <form action="/api/auth/logout" method="post">
            <Button type="submit" variant="outline" data-testid="logout">
              {t('signOut')}
            </Button>
          </form>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <AppSidebar
          groups={groups}
          label={t('mainMenu')}
          collapseLabel={t('collapseSidebar')}
          expandLabel={t('expandSidebar')}
          initialCollapsed={sidebarCollapsed}
        />
        <main
          id="main"
          tabIndex={-1} // the skip link lands here; also lets the keyboard scroll it
          className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto outline-none px-4 pt-4 pb-4 md:px-(--page-padding-x) md:pt-(--page-padding-top)"
        >
          {readOnly && <InfoBanner>{t('readOnlyBanner')}</InfoBanner>}
          {children}
        </main>
      </div>
    </div>
  );
}
