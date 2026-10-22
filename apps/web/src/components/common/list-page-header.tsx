import type { ReactNode } from 'react';

/** Title, subtitle and the count badge of a list; a thin bar under it shows a background refresh. */
export function ListPageHeader({
  title,
  description,
  count,
  countLabel,
  refreshing,
  refreshingLabel,
  actions,
}: Readonly<{
  title: string;
  description?: string;
  /** Already translated ("142 documents"); the badge is hidden while it is undefined. */
  count?: ReactNode;
  countLabel?: string;
  refreshing: boolean;
  refreshingLabel: string;
  /** Page-level buttons (refresh), on the right of the title row. */
  actions?: ReactNode;
}>) {
  return (
    <header className="flex flex-none flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {count !== undefined && (
          <span
            data-testid="list-count"
            aria-label={countLabel}
            className="rounded-full bg-muted px-2.5 py-0.5 text-sm font-medium"
          >
            {count}
          </span>
        )}
        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </div>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
      <div className="h-0.5 overflow-hidden rounded-full bg-transparent">
        {refreshing && (
          <div
            role="progressbar"
            aria-label={refreshingLabel}
            data-testid="list-refreshing"
            className="h-full w-1/3 animate-pulse rounded-full bg-primary"
          />
        )}
      </div>
    </header>
  );
}
