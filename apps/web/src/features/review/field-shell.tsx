'use client';

import { TriangleAlert } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useReview } from './review-context';

export type ControlProps = {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
  readOnly: boolean;
  onFocus: () => void;
};

/**
 * Label + control + schema error, and the "look at this" treatment for a weak field: a yellow
 * frame and a tooltip with the reasons (low confidence, no confidence, rule warnings). The reasons
 * are also in an sr-only description, so they do not depend on hovering. Focusing the control asks
 * the viewer to jump to the field's evidence.
 */
export function FieldShell({
  path,
  label,
  hideLabel = false,
  error,
  hint,
  className,
  children,
}: Readonly<{
  path: string;
  label: string;
  /** In a table the column header is the visible label; this one stays for screen readers. */
  hideLabel?: boolean;
  error?: string;
  hint?: string;
  className?: string;
  children: (control: ControlProps) => ReactNode;
}>) {
  const id = useId();
  const { weak, readOnly, reasonText, onFocusPath } = useReview();
  const reasons = weak.get(path) ?? [];
  const isWeak = reasons.length > 0;
  const described = [
    isWeak && `${id}-reasons`,
    hint && `${id}-hint`,
    error && `${id}-error`,
  ].filter(Boolean);

  const control = children({
    id,
    'aria-describedby': described.length > 0 ? described.join(' ') : undefined,
    'aria-invalid': error ? true : undefined,
    readOnly,
    onFocus: () => onFocusPath(path),
  });

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <Label htmlFor={id} className={hideLabel ? 'sr-only' : undefined}>
        {label}
      </Label>
      {isWeak ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              data-weak="true"
              data-path={path}
              className="relative rounded-lg [&_input]:border-warning [&_input]:bg-warning-soft [&_input]:text-warning-soft-foreground"
            >
              {control}
              <TriangleAlert
                aria-hidden
                className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-warning"
              />
            </div>
          </TooltipTrigger>
          <TooltipContent>
            <ul className="flex list-disc flex-col gap-1 pl-4">
              {reasons.map((r, i) => (
                <li key={`${r.kind}-${i}`}>{reasonText(r)}</li>
              ))}
            </ul>
          </TooltipContent>
        </Tooltip>
      ) : (
        control
      )}
      {isWeak && (
        // Visible for fields with their own label (touch has no hover); table cells rely on the
        // tooltip and the warnings list, a visible line in every cell would drown the table.
        <span
          id={`${id}-reasons`}
          className={hideLabel ? 'sr-only' : 'text-xs text-warning'}
          data-testid={hideLabel ? undefined : 'weak-reason'}
        >
          {reasons.map(reasonText).join(' ')}
        </span>
      )}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-xs font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
