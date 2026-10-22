// Menu = the screens of PRD §4 that appear in the sidebar. `permission` uses the names the API
// returns from /auth/me (apps/api permissions.ts is the only place the role matrix lives).
export interface NavItem {
  id: 'documents' | 'upload' | 'ask' | 'insights' | 'members';
  href: string;
  permission: string;
  /** Sidebar section (title in messages `Nav.groups`). */
  group: NavGroupId;
}

export const NAV_GROUPS = ['workspace', 'analysis', 'settings'] as const;
export type NavGroupId = (typeof NAV_GROUPS)[number];

export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'documents', href: '/documents', permission: 'document:read', group: 'workspace' },
  { id: 'upload', href: '/upload', permission: 'document:create', group: 'workspace' },
  { id: 'ask', href: '/ask', permission: 'qa:ask', group: 'analysis' },
  { id: 'insights', href: '/insights', permission: 'insights:read', group: 'analysis' },
  { id: 'members', href: '/settings/members', permission: 'tenant:manage', group: 'settings' },
];

/**
 * UI convenience only: hiding an item removes a dead end, it protects nothing. The API refuses
 * the call with 403 whatever the menu shows.
 */
export const visibleNavItems = (permissions: readonly string[]): NavItem[] =>
  NAV_ITEMS.filter((i) => permissions.includes(i.permission));

/** The visible items under their section titles, in menu order; a section with nothing visible is left out. */
export function groupedNavItems(
  permissions: readonly string[],
): { id: NavGroupId; items: NavItem[] }[] {
  const visible = visibleNavItems(permissions);
  return NAV_GROUPS.map((id) => ({ id, items: visible.filter((i) => i.group === id) })).filter(
    (g) => g.items.length > 0,
  );
}
