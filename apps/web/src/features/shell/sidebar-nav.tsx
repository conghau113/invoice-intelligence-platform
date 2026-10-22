'use client';

import { BarChart3, FileText, MessageSquare, Upload, Users, type LucideIcon } from 'lucide-react';
import { Link, usePathname } from '@/i18n/navigation';
import { cn } from '@/lib/utils';
import type { NavGroupId, NavItem } from './nav-items';

// Icons live here, not in nav-items.ts: this is a client component and icon functions cannot be
// passed from a Server Component as props.
const ICONS: Record<NavItem['id'], LucideIcon> = {
  documents: FileText,
  upload: Upload,
  ask: MessageSquare,
  insights: BarChart3,
  members: Users,
};

export type SidebarEntry = Pick<NavItem, 'id' | 'href'> & { label: string };
export type SidebarGroup = { id: NavGroupId; label: string; items: SidebarEntry[] };

// The same menu is rendered twice (desktop sidebar, mobile drawer): `testIdPrefix` keeps test ids unique.
// `collapsed` shows icons only: the label stays as the accessible name and the tooltip.
export function SidebarNav({
  groups,
  label,
  testIdPrefix = '',
  collapsed = false,
}: Readonly<{
  groups: readonly SidebarGroup[];
  label: string;
  testIdPrefix?: string;
  collapsed?: boolean;
}>) {
  const pathname = usePathname();
  return (
    <nav
      aria-label={label}
      data-testid={`${testIdPrefix}sidebar-nav`}
      className="flex flex-col gap-4"
    >
      {groups.map((group) => (
        <div key={group.id} role="group" aria-label={group.label} className="flex flex-col gap-1">
          {collapsed ? (
            <hr aria-hidden className="mx-2 my-1 border-sidebar-border" />
          ) : (
            <p className="px-3 pb-1 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              {group.label}
            </p>
          )}
          <ul className="flex flex-col gap-1">
            {group.items.map((item) => {
              const Icon = ICONS[item.id];
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <li key={item.id}>
                  <Link
                    href={item.href}
                    data-testid={`${testIdPrefix}nav-${item.id}`}
                    aria-current={active ? 'page' : undefined}
                    aria-label={collapsed ? item.label : undefined}
                    title={collapsed ? item.label : undefined}
                    className={cn(
                      'flex items-center gap-2 rounded-md py-2 text-sm font-medium text-sidebar-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-sidebar-ring/50',
                      collapsed ? 'justify-center px-0' : 'px-3',
                      // The active item is told apart by more than colour: weight and aria-current.
                      active &&
                        'bg-nav-active font-semibold text-nav-active-foreground hover:bg-nav-active',
                    )}
                  >
                    <Icon aria-hidden className="size-4 shrink-0" />
                    {!collapsed && <span className="min-w-0 truncate">{item.label}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
