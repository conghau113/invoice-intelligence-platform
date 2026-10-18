// Theme lives in a cookie so the server can put the class on <html> before first paint (no flash).
export const THEME_COOKIE = 'theme';
export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

/** Anything that is not exactly "dark" is light: the cookie is user-controlled input. */
export function parseTheme(value: string | undefined): Theme {
  return value === 'dark' ? 'dark' : 'light';
}

export function nextTheme(theme: Theme): Theme {
  return theme === 'dark' ? 'light' : 'dark';
}

export function themeCookie(theme: Theme): string {
  return `${THEME_COOKIE}=${theme}; path=/; max-age=31536000; samesite=lax`;
}
