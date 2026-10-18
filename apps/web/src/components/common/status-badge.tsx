import { Ban, CircleCheck, CircleX, Clock, Loader, TriangleAlert, Upload } from 'lucide-react';
import type { ComponentType } from 'react';
import { Badge } from '@/components/ui/badge';

// Same values as the document state machine in docs/architecture/ARCHITECTURE.md section 8.
export const DOCUMENT_STATUSES = [
  'uploaded',
  'queued',
  'processing',
  'needs_review',
  'approved',
  'rejected',
  'failed',
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

// Every status has an icon and a word, so colour is never the only signal.
export const STATUS_STYLE: Record<
  DocumentStatus,
  { tone: Tone; Icon: ComponentType<{ 'aria-hidden'?: boolean }> }
> = {
  uploaded: { tone: 'neutral', Icon: Upload },
  queued: { tone: 'neutral', Icon: Clock },
  processing: { tone: 'info', Icon: Loader },
  needs_review: { tone: 'warning', Icon: TriangleAlert },
  approved: { tone: 'success', Icon: CircleCheck },
  rejected: { tone: 'danger', Icon: Ban },
  failed: { tone: 'danger', Icon: CircleX },
};

/** `label` is already translated by the caller (keys: `Status.<status>`). */
export function StatusBadge({
  status,
  label,
}: Readonly<{ status: DocumentStatus; label: string }>) {
  const { tone, Icon } = STATUS_STYLE[status];
  return (
    <Badge tone={tone} data-status={status}>
      <Icon aria-hidden />
      {label}
    </Badge>
  );
}
