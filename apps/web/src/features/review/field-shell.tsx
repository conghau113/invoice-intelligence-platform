'use client';

import { TriangleAlert } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useReview } from './review-context';
import { fieldMark, type WeakReason } from './weak-fields';

export type ControlProps = {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
  readOnly: boolean;
  onFocus: () => void;
};

/**
 * Label + control + schema error, and how much attention the field asks for (`fieldMark`):
 * - a reason to doubt the value: yellow frame, warning icon, tooltip with the reasons;
 * - no confidence from the AI: only a dashed frame, no yellow and no icon; the card says in one
 *   sentence what the frame means (`NoMetaNote`).
 * The reasons are also the control's description, so they do not depend on hovering or on seeing the
 * frame. Focusing the control asks the viewer to jump to the field's evidence.
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
  const mark = fieldMark(reasons);
  const visibleReason = mark === 'warning' && !hideLabel;
  const described = [
    mark !== null && `${id}-reasons`,
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
      <MarkedControl
        mark={mark}
        path={path}
        reasons={reasons}
        reasonText={reasonText}
        control={control}
      />
      {mark !== null && (
        // A warning is visible on a field with its own label (touch has no hover). Table cells rely
        // on the tooltip and the notes under the table, a visible line in every cell would drown it.
        <span
          id={`${id}-reasons`}
          className={visibleReason ? 'text-xs text-warning' : 'sr-only'}
          data-testid={visibleReason ? 'weak-reason' : undefined}
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

function MarkedControl({
  mark,
  path,
  reasons,
  reasonText,
  control,
}: Readonly<{
  mark: ReturnType<typeof fieldMark>;
  path: string;
  reasons: readonly WeakReason[];
  reasonText: (reason: WeakReason) => string;
  control: ReactNode;
}>) {
  if (mark === null) return control;
  if (mark === 'noMeta') {
    return (
      <div data-no-meta="true" data-path={path} className="rounded-lg [&_input]:border-dashed">
        {control}
      </div>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          data-weak="true"
          data-path={path}
          className="relative rounded-lg [&_input]:border-warning [&_input]:bg-warning-soft [&_input]:text-warning-soft-foreground"
        >
          {control}
          {/* On the corner, above the line of text: inside the box it would cover a right-aligned
              number, and padding for it would leave a narrow table cell no room for the number. */}
          <TriangleAlert
            aria-hidden
            data-testid="weak-icon"
            className="pointer-events-none absolute -top-1.5 -right-1.5 size-3.5 rounded-full bg-card text-warning"
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
  );
}
