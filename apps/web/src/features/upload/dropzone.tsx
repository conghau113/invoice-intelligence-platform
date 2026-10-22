'use client';

import { UploadCloud } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ACCEPT_ATTRIBUTE } from './validate';

/** Drag-and-drop area plus a plain file picker (keyboard and touch users have no drag). */
export function Dropzone({ onFiles }: Readonly<{ onFiles: (files: File[]) => void }>) {
  const t = useTranslations('Upload');
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (e.dataTransfer.files.length > 0) onFiles(Array.from(e.dataTransfer.files));
  };

  return (
    <section
      data-testid="dropzone"
      data-over={over}
      aria-label={t('dropzoneTitle')}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cn(
        'flex flex-col items-center gap-3 rounded-lg border-2 border-dashed bg-card p-8 text-center transition-colors',
        over && 'border-primary bg-muted',
      )}
    >
      <UploadCloud aria-hidden className="size-8 text-muted-foreground" />
      <p className="font-medium">{t('dropzoneTitle')}</p>
      <p className="text-sm text-muted-foreground">{t('dropzoneHint')}</p>
      <input
        ref={input}
        data-testid="file-input"
        type="file"
        multiple
        accept={ACCEPT_ATTRIBUTE}
        aria-label={t('fileInput')}
        className="sr-only"
        onChange={(e) => {
          onFiles(Array.from(e.target.files ?? []));
          e.target.value = ''; // choosing the same file again must fire onChange
        }}
      />
      <Button type="button" onClick={() => input.current?.click()}>
        {t('choose')}
      </Button>
    </section>
  );
}
