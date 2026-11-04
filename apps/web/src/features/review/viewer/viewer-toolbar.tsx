'use client';

import { Minus, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { DEFAULT_ZOOM, stepZoom, ZOOM_STEPS } from './zoom';

/** Zoom buttons (and whatever the viewer adds, e.g. page buttons) above a viewer. */
export function ViewerToolbar({
  zoom,
  onZoom,
  children,
}: Readonly<{ zoom: number; onZoom: (zoom: number) => void; children?: ReactNode }>) {
  const t = useTranslations('Review.viewer');
  return (
    <div
      role="toolbar"
      aria-label={t('toolbar')}
      className="flex flex-none flex-wrap items-center gap-2 border-b bg-card px-3 py-2"
    >
      {children}
      <div className="ml-auto flex items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={t('zoomOut')}
          disabled={zoom <= ZOOM_STEPS[0]}
          onClick={() => onZoom(stepZoom(zoom, -1))}
        >
          <Minus aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={t('zoomReset')}
          data-testid="zoom-level"
          onClick={() => onZoom(DEFAULT_ZOOM)}
        >
          {zoom}%
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={t('zoomIn')}
          disabled={zoom >= ZOOM_STEPS.at(-1)!}
          onClick={() => onZoom(stepZoom(zoom, 1))}
        >
          <Plus aria-hidden />
        </Button>
      </div>
    </div>
  );
}
