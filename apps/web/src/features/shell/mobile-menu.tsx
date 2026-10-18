'use client';

import { Menu } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { usePathname } from '@/i18n/navigation';

/** Native <details> drawer that also closes after navigating and on Escape (focus back to the button). */
export function MobileMenu({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  const ref = useRef<HTMLDetailsElement>(null);
  const pathname = usePathname();
  useEffect(() => {
    if (ref.current) ref.current.open = false;
  }, [pathname]);
  return (
    <details
      ref={ref}
      className="relative md:hidden"
      data-testid="mobile-menu"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && ref.current?.open) {
          ref.current.open = false;
          ref.current.querySelector('summary')?.focus();
        }
      }}
    >
      <summary
        aria-label={label}
        className="flex size-9 cursor-pointer list-none items-center justify-center rounded-md border border-input outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
      >
        <Menu aria-hidden className="size-4" />
      </summary>
      <div className="absolute left-0 top-11 z-40 w-60 rounded-md border border-sidebar-border bg-sidebar p-3 shadow-md">
        {children}
      </div>
    </details>
  );
}
