import { CircleAlert, Inbox } from 'lucide-react';
import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

type Props = {
  kind: 'loading' | 'empty' | 'error';
  title: string;
  description?: string;
  action?: ReactNode;
  /** No border or background: the panel around it (a table body) already has them. */
  bare?: boolean;
};

/** One look for the three non-happy states. Strings are translated by the caller. */
export function StatePanel({ kind, title, description, action, bare }: Readonly<Props>) {
  const frame = bare ? '' : 'rounded-lg border bg-card';
  if (kind === 'loading') {
    return (
      <output aria-busy="true" className={cn('flex flex-col gap-2 p-4', frame)}>
        <span className="sr-only">{title}</span>
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </output>
    );
  }
  const Icon = kind === 'error' ? CircleAlert : Inbox;
  return (
    <div
      role={kind === 'error' ? 'alert' : undefined}
      className={cn('flex flex-col items-center gap-2 p-8 text-center', frame)}
    >
      <Icon
        aria-hidden
        className={kind === 'error' ? 'size-8 text-destructive' : 'size-8 text-muted-foreground'}
      />
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-prose text-sm text-muted-foreground">{description}</p>}
      {action}
    </div>
  );
}
