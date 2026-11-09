import { cn } from '@/lib/utils';

export interface Bar {
  key: string;
  label: string;
  /** 0..1; the bar width. */
  ratio: number;
  /** The number written next to the bar, already formatted. */
  value: string;
}

/**
 * Horizontal bars in plain HTML: a list a screen reader reads as "label: value", with the bar
 * itself hidden from it. No chart library: a few bars do not need one (T4.6). The width is set
 * from a number between 0 and 1, clamped, never from text.
 */
export function BarList({
  bars,
  label,
  tone = 'primary',
}: Readonly<{ bars: Bar[]; label: string; tone?: 'primary' | 'warning' }>) {
  return (
    // role="list" is explicit: Safari drops the list role of a styled <ul>.
    <ul role="list" aria-label={label} className="flex flex-col gap-2">
      {bars.map((bar) => (
        <li
          key={bar.key}
          data-testid={`bar-${bar.key}`}
          className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto] items-center gap-3 text-sm"
        >
          <span className="truncate" title={bar.label}>
            {bar.label}
          </span>
          <span aria-hidden className="h-2.5 overflow-hidden rounded-full bg-muted">
            <span
              className={cn(
                'block h-full rounded-full',
                tone === 'warning' ? 'bg-chart-4' : 'bg-chart-1',
              )}
              style={{ width: `${Math.min(1, Math.max(0, bar.ratio)) * 100}%` }}
            />
          </span>
          <span className="text-right font-mono tabular-nums">{bar.value}</span>
        </li>
      ))}
    </ul>
  );
}
