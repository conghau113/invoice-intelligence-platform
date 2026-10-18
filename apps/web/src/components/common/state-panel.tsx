import { CircleAlert, Inbox } from 'lucide-react';
import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';

type Props = {
  kind: 'loading' | 'empty' | 'error';
  title: string;
  description?: string;
  action?: ReactNode;
};

/** One look for the three non-happy states. Strings are translated by the caller. */
export function StatePanel({ kind, title, description, action }: Readonly<Props>) {
  if (kind === 'loading') {
    return (
      <output aria-busy="true" className="flex flex-col gap-2 rounded-lg border bg-card p-4">
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
      className="flex flex-col items-center gap-2 rounded-lg border bg-card p-8 text-center"
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
