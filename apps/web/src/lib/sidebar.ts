// Sidebar collapse lives in a cookie for the same reason the theme does: the server reads it and
// renders the right width on the first paint, so a reload does not flash the wide sidebar.
export const SIDEBAR_COOKIE = 'sidebar';

/** Anything that is not exactly "collapsed" is expanded: the cookie is user-controlled input. */
export const parseSidebarCollapsed = (value: string | undefined): boolean => value === 'collapsed';

export function sidebarCookie(collapsed: boolean): string {
  return `${SIDEBAR_COOKIE}=${collapsed ? 'collapsed' : 'expanded'}; path=/; max-age=31536000; samesite=lax`;
}
