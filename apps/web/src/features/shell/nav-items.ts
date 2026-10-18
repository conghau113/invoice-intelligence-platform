// Menu = the screens of PRD §4 that appear in the sidebar. `permission` uses the names the API
// returns from /auth/me (apps/api permissions.ts is the only place the role matrix lives).
export interface NavItem {
  id: 'documents' | 'upload' | 'ask' | 'insights' | 'members';
  href: string;
  permission: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'documents', href: '/documents', permission: 'document:read' },
  { id: 'upload', href: '/upload', permission: 'document:create' },
  { id: 'ask', href: '/ask', permission: 'qa:ask' },
  { id: 'insights', href: '/insights', permission: 'insights:read' },
  { id: 'members', href: '/settings/members', permission: 'tenant:manage' },
];

/**
 * UI convenience only: hiding an item removes a dead end, it protects nothing. The API refuses
 * the call with 403 whatever the menu shows.
 */
export const visibleNavItems = (permissions: readonly string[]): NavItem[] =>
  NAV_ITEMS.filter((i) => permissions.includes(i.permission));
