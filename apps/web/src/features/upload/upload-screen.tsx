'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Dropzone } from './dropzone';
import { UploadList } from './upload-list';
import { useUploadQueue } from './use-upload-queue';

export function UploadScreen() {
  const t = useTranslations('Upload');
  const { queue, items } = useUploadQueue();
  return (
    <section className="flex flex-col gap-4">
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
          <div>
            <Button type="button" variant="ghost" size="sm" onClick={() => queue.clearSettled()}>
              {t('clear')}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
