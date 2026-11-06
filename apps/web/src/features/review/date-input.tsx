'use client';

import { CalendarDays } from 'lucide-react';
import { useRef, useState, type ComponentProps } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatDateText, isIsoDate, parseDateText } from './date-text';

type Props = Omit<ComponentProps<typeof Input>, 'value' | 'onChange' | 'type'> & {
  /** ISO 8601 while it is a date; otherwise the text being typed, which the schema then rejects. */
  value: string;
  onChange: (value: string) => void;
  locale: string;
  pickLabel: string;
  /** The person went to the calendar instead of the box: same as focusing the field. */
  onPick?: () => void;
};

/**
 * A text box that holds a date: shown in the interface language, ISO 8601 in the form. Typed text
 * stays as typed until the box loses focus. The calendar is the browser's own, opened from a hidden
 * `type="date"` input that only ever exchanges ISO values with this box.
 */
export function DateInput({
  value,
  onChange,
  locale,
  pickLabel,
  onPick,
  onBlur,
  'data-testid': testId,
  ...rest
}: Readonly<Props & { 'data-testid'?: string }>) {
  const [text, setText] = useState(() => formatDateText(value, locale));
  const [seen, setSeen] = useState(value);
  const picker = useRef<HTMLInputElement>(null);
  // Changed from outside (reset, calendar): the text follows. When the change came from typing here,
  // the text already parses to the value and is left as typed.
  if (seen !== value) {
    setSeen(value);
    if (parseDateText(text, locale) !== value) setText(formatDateText(value, locale));
  }
  return (
    <div className="relative">
      <Input
        {...rest}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        data-testid={testId}
        className="pr-9"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseDateText(e.target.value, locale));
        }}
        onBlur={(e) => {
          // Tidy "8/1/2026" once it is a date; anything else stays as typed so it can be fixed.
          if (isIsoDate(value)) setText(formatDateText(value, locale));
          onBlur?.(e);
        }}
      />
      {!rest.readOnly && (
        <>
          <input
            ref={picker}
            type="date"
            tabIndex={-1}
            aria-hidden
            className="sr-only right-2 bottom-0" // the calendar opens where this input is
            data-testid={testId === undefined ? undefined : `${testId}-picker`}
            value={isIsoDate(value) ? value : ''}
            onChange={(e) => onChange(e.target.value)}
          />
          <Button
            type="button"
            variant="ghost"
            aria-label={pickLabel}
            className="absolute top-1/2 right-2 size-6 -translate-y-1/2 p-0"
            onClick={() => {
              onPick?.();
              try {
                picker.current?.showPicker();
              } catch {
                // Not allowed here or not supported by this browser: typing the date still works.
              }
            }}
          >
            <CalendarDays aria-hidden className="size-3.5" />
          </Button>
        </>
      )}
    </div>
  );
}
