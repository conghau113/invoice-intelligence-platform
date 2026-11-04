'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { StatePanel } from '@/components/common/state-panel';
import { findInText } from '../evidence-match';
import type { ViewerEvidence } from './types';
import { ViewerToolbar } from './viewer-toolbar';
import { DEFAULT_ZOOM } from './zoom';

/** XML source as text (the API serves it as text/plain). The evidence excerpt, if found, is marked. */
export function TextViewer({
  url,
  evidence,
}: Readonly<{ url: string; evidence: ViewerEvidence | null }>) {
  const t = useTranslations('Review.viewer');
  // The result remembers its url, so a different document never shows the previous one's text.
  const [result, setResult] = useState<{ url: string; text: string | null } | null>(null);
  const text = result?.url === url ? result.text : null;
  const failed = result?.url === url && result.text === null;
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const mark = useRef<HTMLElement>(null);

  useEffect(() => {
    const abort = new AbortController();
    fetch(url, { signal: abort.signal, cache: 'no-store' })
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error('file'))))
      .then((body) => setResult({ url, text: body }))
      .catch(() => {
        if (!abort.signal.aborted) setResult({ url, text: null });
      });
    return () => abort.abort();
  }, [url]);

  const range = text !== null && evidence ? findInText(text, evidence.text) : null;
  useEffect(() => {
    mark.current?.scrollIntoView({ block: 'nearest' });
  }, [text, evidence]);

  if (failed) return <StatePanel kind="error" title={t('loadError')} />;
  if (text === null) return <StatePanel kind="loading" title={t('loading')} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="text-viewer">
      <ViewerToolbar zoom={zoom} onZoom={setZoom} />
      <pre
        className="min-h-0 flex-1 overflow-auto bg-card p-3 font-mono whitespace-pre-wrap break-all"
        style={{ fontSize: `${0.75 * (zoom / 100)}rem` }}
        tabIndex={0}
      >
        {range ? (
          <>
            {text.slice(0, range.start)}
            <mark ref={mark} data-testid="evidence-mark" className="bg-warning/50 text-foreground">
              {text.slice(range.start, range.end)}
            </mark>
            {text.slice(range.end)}
          </>
        ) : (
          text
        )}
      </pre>
    </div>
  );
}
