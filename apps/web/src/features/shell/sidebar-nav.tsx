'use client';

import { BarChart3, FileText, MessageSquare, Upload, Users, type LucideIcon } from 'lucide-react';
import { Link, usePathname } from '@/i18n/navigation';
import { cn } from '@/lib/utils';
import type { NavItem } from './nav-items';

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

// The same menu is rendered twice (desktop sidebar, mobile drawer): `testIdPrefix` keeps test ids unique.
export function SidebarNav({
  items,
  label,
  testIdPrefix = '',
}: Readonly<{ items: readonly SidebarEntry[]; label: string; testIdPrefix?: string }>) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} data-testid={`${testIdPrefix}sidebar-nav`}>
      <ul className="flex flex-col gap-1">
        {items.map((item) => {
          const Icon = ICONS[item.id];
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <li key={item.id}>
              <Link
                href={item.href}
                data-testid={`${testIdPrefix}nav-${item.id}`}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-sidebar-ring/50',
                  active && 'bg-sidebar-accent text-sidebar-accent-foreground',
                )}
              >
                <Icon aria-hidden className="size-4" />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
