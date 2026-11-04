'use client';

import 'pdfjs-dist/web/pdf_viewer.css';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useEffect, useRef, useState } from 'react';
import { StatePanel } from '@/components/common/state-panel';
import { Button } from '@/components/ui/button';
import { findEvidence } from '../evidence-match';
import type { ViewerEvidence } from './types';
import { ViewerToolbar } from './viewer-toolbar';
import { DEFAULT_ZOOM } from './zoom';

// This module is only ever loaded in the browser, lazily (document-viewer.tsx). The worker file
// comes from our own bundle, not a CDN. Set once per page.
function ensureWorker() {
  if (!pdfjs.GlobalWorkerOptions.workerPort) {
    pdfjs.GlobalWorkerOptions.workerPort = new Worker(
      new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url),
      { type: 'module' },
    );
  }
}

const SIDE_PADDING = 16;
const HIT_CLASSES = ['bg-warning/50', 'rounded-sm'];

/**
 * Renders one page at a time to a canvas, with pdf.js's text layer on top. The text layer is how
 * "jump to evidence" can mark something: the evidence only has page + text (no coordinates), so
 * the excerpt is searched in the page's text and those pieces are highlighted.
 */
export default function PdfViewer({
  url,
  evidence,
}: Readonly<{ url: string; evidence: ViewerEvidence | null }>) {
  const t = useTranslations('Review.viewer');
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [failed, setFailed] = useState(false);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [width, setWidth] = useState(0);
  const [hits, setHits] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textLayer = useRef<HTMLDivElement>(null);
  // The render still finishing from the previous run: a canvas cannot take two renders at once.
  const lastRender = useRef<pdfjs.RenderTask | undefined>(undefined);

  useEffect(() => {
    ensureWorker();
    const abort = new AbortController();
    let task: pdfjs.PDFDocumentLoadingTask | null = null;
    (async () => {
      const res = await fetch(url, { signal: abort.signal, cache: 'no-store' });
      if (!res.ok) throw new Error('file');
      const data = new Uint8Array(await res.arrayBuffer());
      // Scripting inside PDFs is off by default; pdf.js 6 no longer uses eval for fonts.
      task = pdfjs.getDocument({ data, enableXfa: false, stopAtErrors: true });
      const loaded = await task.promise;
      if (abort.signal.aborted) return;
      setDoc(loaded);
      setPage(1);
    })().catch(() => {
      if (!abort.signal.aborted) setFailed(true);
    });
    return () => {
      abort.abort();
      void task?.destroy(); // also closes the document and stops its worker requests
    };
  }, [url]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // A new evidence (the reviewer clicked a field) moves to its page. Done while rendering, the
  // way React advises for "state that follows a prop", so there is no extra render pass.
  const [seenEvidence, setSeenEvidence] = useState(evidence);
  if (evidence !== seenEvidence) {
    setSeenEvidence(evidence);
    if (evidence && evidence.page >= 1) setPage(evidence.page);
  }
  const pageNo = doc ? Math.min(Math.max(page, 1), doc.numPages) : page;

  useEffect(() => {
    const cv = canvas.current;
    const layer = textLayer.current;
    if (!doc || !cv || !layer || width === 0) return;
    let cancelled = false;
    let task: pdfjs.RenderTask | undefined;
    (async () => {
      const p = await doc.getPage(pageNo);
      const base = p.getViewport({ scale: 1 });
      const scale = (Math.max(width - SIDE_PADDING, 100) / base.width) * (zoom / 100);
      const viewport = p.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;
      cv.width = Math.floor(viewport.width * ratio);
      cv.height = Math.floor(viewport.height * ratio);
      cv.style.width = `${Math.floor(viewport.width)}px`;
      cv.style.height = `${Math.floor(viewport.height)}px`;
      const ctx = cv.getContext('2d');
      if (!ctx || cancelled) return;
      // Zoom or focus twice quickly: wait for the cancelled render to settle, or pdf.js throws.
      await lastRender.current?.promise.catch(() => undefined);
      if (cancelled) return;
      task = p.render({
        canvasContext: ctx,
        canvas: cv,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      lastRender.current = task;
      await task.promise;
      if (cancelled) return;

      layer.replaceChildren();
      layer.style.width = cv.style.width;
      layer.style.height = cv.style.height;
      layer.style.setProperty('--total-scale-factor', String(viewport.scale));
      const text = new pdfjs.TextLayer({
        textContentSource: p.streamTextContent(),
        container: layer,
        viewport,
      });
      await text.render();
      if (cancelled) return;

      const range =
        evidence && evidence.page === pageNo
          ? findEvidence(text.textContentItemsStr, evidence.text)
          : null;
      let count = 0;
      if (range) {
        for (let i = range.start.item; i <= range.end.item; i++) {
          text.textDivs[i]?.classList.add(...HIT_CLASSES);
          count++;
        }
        text.textDivs[range.start.item]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      setHits(count);
    })().catch((e: unknown) => {
      if (!cancelled && !(e instanceof pdfjs.RenderingCancelledException)) setFailed(true);
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageNo, zoom, width, evidence]);

  if (failed) return <StatePanel kind="error" title={t('loadError')} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="pdf-viewer">
      <ViewerToolbar zoom={zoom} onZoom={setZoom}>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={t('prevPage')}
            disabled={pageNo <= 1}
            onClick={() => setPage(pageNo - 1)}
          >
            <ChevronLeft aria-hidden />
          </Button>
          <span className="px-1 text-sm tabular-nums" data-testid="pdf-page-label">
            {t('pageOf', { page: pageNo, total: doc?.numPages ?? 1 })}
          </span>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={t('nextPage')}
            disabled={doc === null || pageNo >= doc.numPages}
            onClick={() => setPage(pageNo + 1)}
          >
            <ChevronRight aria-hidden />
          </Button>
        </div>
      </ViewerToolbar>
      <div ref={box} className="min-h-0 flex-1 overflow-auto bg-muted p-2">
        {doc === null && <StatePanel kind="loading" title={t('loading')} />}
        <div
          className="relative mx-auto w-fit bg-white"
          hidden={doc === null}
          data-testid="pdf-page"
          data-page={pageNo}
          data-hits={hits}
        >
          <canvas ref={canvas} className="block" />
          <div ref={textLayer} className="textLayer" />
        </div>
      </div>
    </div>
  );
}
