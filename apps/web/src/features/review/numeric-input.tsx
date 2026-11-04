'use client';

import { useState, type ComponentProps } from 'react';
import { Input } from '@/components/ui/input';

type Props = Omit<ComponentProps<typeof Input>, 'value' | 'onChange' | 'type'> & {
  value: number;
  onChange: (value: number) => void;
  parse: (text: string) => number;
  format: (value: number) => string;
};

/**
 * A text box that holds a number. The form value is a number (NaN while the text is not one, which
 * the schema then rejects); the text the user is typing is kept as typed, so "1." or "-" does not
 * jump around. If the value changes from outside (reset, "apply"), the text follows.
 */
export function NumericInput({ value, onChange, parse, format, ...rest }: Readonly<Props>) {
  const [text, setText] = useState(() => format(value));
  const [seen, setSeen] = useState(value);
  // The value changed from outside (reset, "apply"): the text follows. When the change came from
  // typing here, the text already parses to the value and is left as typed ("1." stays "1.").
  if (!Object.is(seen, value)) {
    setSeen(value);
    if (!Object.is(parse(text), value)) setText(format(value));
  }
  return (
    <Input
      {...rest}
      type="text"
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parse(e.target.value));
      }}
    />
  );
}
