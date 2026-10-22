import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The container every page puts its content in. A page with a table passes `fill`: it then takes
 * exactly the height the shell has left and its table panel owns the scrolling. Any other page is
 * as tall as its content, kept to a readable width, and the main area scrolls if it is taller
 * than the window.
 */
export function PageLayout({
  fill = false,
  children,
  className,
  ...rest
}: Readonly<{ fill?: boolean; children: ReactNode; className?: string; 'data-testid'?: string }>) {
  return (
    <section
      {...rest}
      className={cn(
        'flex min-w-0 flex-col gap-4',
        fill ? 'min-h-0 flex-1' : 'mx-auto w-full max-w-(--content-max)',
        className,
      )}
    >
      {children}
    </section>
  );
}
