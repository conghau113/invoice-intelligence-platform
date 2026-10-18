'use client';

import { Moon, Sun } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { nextTheme, themeCookie, type Theme } from '@/lib/theme';

/** `initial` comes from the cookie the server already used for <html class>. */
export function ThemeToggle({ initial }: { initial: Theme }) {
  const t = useTranslations('Theme');
  const [theme, setTheme] = useState<Theme>(initial);
  const toggle = () => {
    const next = nextTheme(theme);
    document.documentElement.classList.toggle('dark', next === 'dark');
    document.cookie = themeCookie(next);
    setTheme(next);
  };
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      aria-pressed={theme === 'dark'}
      aria-label={t('toggle')}
      data-testid="theme-toggle"
      onClick={toggle}
    >
      {theme === 'dark' ? <Moon aria-hidden /> : <Sun aria-hidden />}
    </Button>
  );
}
