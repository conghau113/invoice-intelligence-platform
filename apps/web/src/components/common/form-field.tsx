import { useId, type ReactNode } from 'react';
import { Label } from '@/components/ui/label';

type ControlProps = {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
  'aria-required'?: true;
};

/**
 * Label + control + hint/error wired together (htmlFor, aria-describedby, aria-invalid, aria-required).
 * The control comes from a render function so the ids always match.
 */
export function FormField({
  label,
  hint,
  error,
  required,
  children,
}: Readonly<{
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: (control: ControlProps) => ReactNode;
}>) {
  const id = useId();
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ');
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>
        {label}
        {required && (
          <span aria-hidden className="ml-0.5 text-destructive">
            *
          </span>
        )}
      </Label>
      {children({
        id,
        'aria-describedby': describedBy || undefined,
        'aria-invalid': error ? true : undefined,
        'aria-required': required ? true : undefined,
      })}
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
