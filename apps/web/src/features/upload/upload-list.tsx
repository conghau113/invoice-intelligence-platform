'use client';

import { useTranslations } from 'next-intl';
import { StatusBadge } from '@/components/common/status-badge';
import { Button } from '@/components/ui/button';
import type { UploadItem } from './upload-queue';

const KB = 1024;
const formatSize = (bytes: number): string =>
  bytes < KB * KB
    ? `${Math.max(1, Math.round(bytes / KB))} KB`
    : `${(bytes / KB / KB).toFixed(1)} MB`;

export function UploadList({
  items,
  onCancel,
  onRetry,
}: Readonly<{
  items: readonly UploadItem[];
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
}>) {
  const t = useTranslations('Upload');
  const tStatus = useTranslations('Status');
  return (
    <ul aria-label={t('listLabel')} className="flex flex-col gap-2">
      {items.map((item) => {
        const active = item.state === 'pending' || item.state === 'uploading';
        const canRetry = item.state === 'cancelled' || (item.state === 'error' && item.retryable);
        const name = item.file.name;
        return (
          <li
            key={item.id}
            data-testid={`upload-row-${name}`}
            className="flex flex-col gap-2 rounded-lg border bg-card p-3"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{name}</p>
                <p className="text-xs text-muted-foreground">{formatSize(item.file.size)}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {item.document && (
                  <StatusBadge
                    status={item.document.status}
                    label={tStatus(item.document.status)}
                  />
                )}
                {active && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={t('cancelFile', { name })}
                    onClick={() => onCancel(item.id)}
                  >
                    {t('cancel')}
                  </Button>
                )}
                {canRetry && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={t('retryFile', { name })}
                    onClick={() => onRetry(item.id)}
                  >
                    {t('retry')}
                  </Button>
                )}
              </div>
            </div>
            {item.state === 'uploading' && (
              <div
                role="progressbar"
                aria-label={t('progress', { name })}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={item.progress}
                className="h-2 overflow-hidden rounded-full bg-muted"
              >
                <div className="h-full bg-primary" style={{ width: `${item.progress}%` }} />
              </div>
            )}
            <p
              data-testid={`upload-state-${name}`}
              data-state={item.state}
              role={item.state === 'error' ? 'alert' : undefined}
              className={
                item.state === 'error'
                  ? 'text-sm text-destructive'
                  : 'text-sm text-muted-foreground'
              }
            >
              {item.state === 'error' && item.errorKey
                ? t(`errors.${item.errorKey}`)
                : t(`state.${item.state}`)}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
