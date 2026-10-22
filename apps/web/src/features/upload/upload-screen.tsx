'use client';

import { useTranslations } from 'next-intl';
import { PageLayout } from '@/components/common/page-layout';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { Dropzone } from './dropzone';
import { UploadList } from './upload-list';
import { useUploadQueue } from './use-upload-queue';

export function UploadScreen() {
  const t = useTranslations('Upload');
  const { queue, items } = useUploadQueue();
  return (
    <PageLayout>
      <div>
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      <Dropzone onFiles={(files) => queue.add(files)} />
      {items.length > 0 && (
        <>
          <UploadList
            items={items}
            onCancel={(id) => queue.cancel(id)}
            onRetry={(id) => queue.retry(id)}
          />
          <div className="flex items-center gap-3">
            <Button type="button" variant="ghost" size="sm" onClick={() => queue.clearSettled()}>
              {t('clear')}
            </Button>
            {items.some((i) => i.state === 'done') && (
              <Link href="/documents" data-testid="view-documents" className="text-sm underline">
                {t('viewList')}
              </Link>
            )}
          </div>
        </>
      )}
    </PageLayout>
  );
}
