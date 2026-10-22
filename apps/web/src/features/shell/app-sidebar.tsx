'use client';

import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useState } from 'react';
import { sidebarCookie } from '@/lib/sidebar';
import { cn } from '@/lib/utils';
import { SidebarNav, type SidebarGroup } from './sidebar-nav';

/**
 * Desktop sidebar: the menu scrolls by itself when it is taller than the window, and the collapse
 * button stays below it, outside that scroll. The width comes from tokens; main content takes the
 * rest because the workspace is a flex row. Below `md` it is hidden (the drawer takes over).
 */
export function AppSidebar({
  groups,
  label,
  collapseLabel,
  expandLabel,
  initialCollapsed,
}: Readonly<{
  groups: readonly SidebarGroup[];
  label: string;
  collapseLabel: string;
  expandLabel: string;
  initialCollapsed: boolean;
}>) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      document.cookie = sidebarCookie(next); // read by the server on the next request
    } catch {
      // Cookies blocked: the sidebar still works, it just forgets on reload.
    }
  };
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const action = collapsed ? expandLabel : collapseLabel;
  return (
    <aside
      data-testid="sidebar"
      data-collapsed={collapsed}
      className={cn(
        'hidden min-h-0 flex-none flex-col border-r border-sidebar-border bg-sidebar md:flex',
        collapsed ? 'w-(--sidebar-collapsed-width)' : 'w-(--sidebar-width)',
      )}
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <SidebarNav groups={groups} label={label} collapsed={collapsed} />
      </div>
      <div className="flex-none border-t border-sidebar-border p-3">
        <button
          type="button"
          data-testid="sidebar-toggle"
          aria-expanded={!collapsed}
          aria-label={action}
          title={collapsed ? action : undefined}
          onClick={toggle}
          className={cn(
            'flex w-full items-center gap-2 rounded-md py-2 text-sm font-medium text-sidebar-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-sidebar-ring/50',
            collapsed ? 'justify-center px-0' : 'px-3',
          )}
        >
          <Icon aria-hidden className="size-4 shrink-0" />
          {!collapsed && <span className="min-w-0 truncate">{collapseLabel}</span>}
        </button>
      </div>
    </aside>
  );
}
