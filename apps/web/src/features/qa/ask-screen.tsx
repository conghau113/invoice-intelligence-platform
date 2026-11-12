'use client';

import { QA_MAX_QUESTION_CHARS } from 'contracts';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useState, type KeyboardEvent } from 'react';
import { PageLayout } from '@/components/common/page-layout';
import { Button } from '@/components/ui/button';
import { AggregateView } from './aggregate-view';
import { AnswerText } from './answer-text';
import type { AskFailure } from './ask-client';
import type { AskState } from './ask-state';
import { CitationChip } from './citation-chip';
import { useAsk } from './use-ask';

export function AskScreen() {
  const { state, submit, stop } = useAsk();
  return <AskView state={state} onAsk={submit} onStop={stop} />;
}

/** The screen for a given state; split from `AskScreen` so it renders without a network. */
export function AskView({
  state,
  onAsk,
  onStop,
}: Readonly<{ state: AskState; onAsk: (question: string) => void; onStop: () => void }>) {
  const t = useTranslations('Qa');
  const [question, setQuestion] = useState('');
  const id = useId();
  const running = state.phase === 'waiting' || state.phase === 'streaming';
  const trimmed = question.trim();
  const tooLong = trimmed.length > QA_MAX_QUESTION_CHARS;
  const canAsk = !running && trimmed.length > 0 && !tooLong;

  function send() {
    if (canAsk) onAsk(trimmed);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter is a new line. Not while an IME (Vietnamese Telex) is composing:
    // that Enter confirms the word.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }

  return (
    <PageLayout data-testid="qa-screen">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </header>

      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <label htmlFor={id} className="text-sm font-medium">
          {t('label')}
        </label>
        <textarea
          id={id}
          data-testid="qa-question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
          placeholder={t('placeholder')}
          aria-invalid={tooLong || undefined}
          aria-describedby={`${id}-count`}
          className="min-h-20 w-full resize-y rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 aria-invalid:border-destructive"
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span
            id={`${id}-count`}
            className={tooLong ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
          >
            {t('count', { count: trimmed.length, max: QA_MAX_QUESTION_CHARS })}
          </span>
          <div className="flex gap-2">
            {running && (
              <Button type="button" variant="outline" data-testid="qa-stop" onClick={onStop}>
                {t('stop')}
              </Button>
            )}
            <Button type="submit" data-testid="qa-ask" disabled={!canAsk}>
              {t('ask')}
            </Button>
          </div>
        </div>
      </form>

      <Result state={state} />
    </PageLayout>
  );
}

function Result({ state }: Readonly<{ state: AskState }>) {
  const t = useTranslations('Qa');
  if (state.phase === 'idle') return null;
  const partial = state.text !== '' || state.aggregate !== null;

  return (
    <section
      className="flex flex-col gap-3 rounded-lg border bg-card p-4"
      data-testid="qa-result"
      data-phase={state.phase}
      aria-busy={state.phase === 'waiting' || state.phase === 'streaming'}
    >
      <p className="text-sm font-medium">{state.question}</p>

      {/* Announced to screen readers: what is happening, not the answer itself token by token. */}
      <div role="status" className="text-sm text-muted-foreground">
        {state.phase === 'waiting' && (
          <span className="flex items-center gap-2" data-testid="qa-waiting">
            <Loader2 aria-hidden className="size-4 animate-spin" />
            {t('waiting')}
          </span>
        )}
        {state.phase === 'cancelled' && <span data-testid="qa-cancelled">{t('cancelled')}</span>}
        {state.phase === 'done' && <span className="sr-only">{t('finished')}</span>}
      </div>

      {state.phase === 'refused' && state.refusal !== null && (
        <p data-testid="qa-refusal" data-reason={state.refusal}>
          {t(`refusal.${state.refusal}`)}
        </p>
      )}
      {state.text !== '' && <AnswerText text={state.text} citations={state.citations} />}
      {state.aggregate !== null && <AggregateView result={state.aggregate} />}
      {state.aggregate !== null && state.citations !== null && state.citations.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-sm text-muted-foreground">
            {t('sources', { shown: state.citations.length, total: state.aggregate.invoiceCount })}
          </p>
          <p className="flex flex-wrap gap-y-1">
            {state.citations.map((c) => (
              <CitationChip key={c.n} n={c.n} citation={c} />
            ))}
          </p>
        </div>
      )}

      {state.phase === 'failed' && state.failure !== null && (
        <p role="alert" data-testid="qa-error" className="text-sm text-destructive">
          <FailureText failure={state.failure} />
        </p>
      )}
      {(state.phase === 'failed' || state.phase === 'cancelled') && partial && (
        <p className="text-sm text-warning-soft-foreground" data-testid="qa-unfinished">
          {t('unfinished')}
        </p>
      )}
    </section>
  );
}

function FailureText({ failure }: Readonly<{ failure: AskFailure }>) {
  const t = useTranslations('Qa.error');
  const tApi = useTranslations('ApiError');
  if (failure.kind === 'http') return failure.code ? tApi(failure.code) : t('http');
  return t(failure.kind);
}
