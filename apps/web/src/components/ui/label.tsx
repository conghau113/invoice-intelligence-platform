import * as React from 'react';
import { cn } from '@/lib/utils';

// htmlFor is required: a label with no control to point at is a bug (see FormField).
function Label({
  className,
  htmlFor,
  ...props
}: React.ComponentProps<'label'> & { htmlFor: string }) {
  return (
    <label
      data-slot="label"
      htmlFor={htmlFor}
      className={cn('text-sm leading-none font-medium select-none', className)}
      {...props}
    />
  );
}

export { Label };
