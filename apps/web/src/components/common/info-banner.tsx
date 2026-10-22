import { Info } from 'lucide-react';
import type { ReactNode } from 'react';

/** A notice above the page content (for example read-only mode). Not a dialog: it blocks nothing. */
export function InfoBanner({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div
      role="status"
      data-testid="info-banner"
      className="flex flex-none items-center gap-2 rounded-lg border border-info/40 bg-info-soft px-3 py-2 text-sm text-info-soft-foreground"
    >
      <Info aria-hidden className="size-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}
