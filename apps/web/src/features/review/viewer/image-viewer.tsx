'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { StatePanel } from '@/components/common/state-panel';
import { ViewerToolbar } from './viewer-toolbar';
import { DEFAULT_ZOOM } from './zoom';

/** The page's own image element: same-origin, so the session cookie rides along. Zoom is a width percentage. */
export function ImageViewer({ url }: Readonly<{ url: string }>) {
  const t = useTranslations('Review.viewer');
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [failed, setFailed] = useState(false);
  if (failed) return <StatePanel kind="error" title={t('loadError')} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="image-viewer">
      <ViewerToolbar zoom={zoom} onZoom={setZoom} />
      <div className="min-h-0 flex-1 overflow-auto bg-muted p-2">
        {/* next/image would route through the optimizer; this is an authenticated, private file. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={t('imageAlt')}
          onError={() => setFailed(true)}
          style={{ width: `${zoom}%`, maxWidth: 'none' }}
          className="mx-auto block h-auto bg-white"
        />
      </div>
    </div>
  );
}
