'use client';

import type { QaCitation } from 'contracts';
import { answerSegments } from './answer-segments';
import { CitationChip } from './citation-chip';

/**
 * The model's answer as plain text: React escapes every string, nothing is parsed as markdown or
 * HTML, and a URL stays text. Only `[n]` markers become citation chips.
 */
export function AnswerText({
  text,
  citations,
}: Readonly<{ text: string; citations: QaCitation[] | null }>) {
  return (
    <p className="leading-7 whitespace-pre-wrap" data-testid="qa-answer">
      {answerSegments(text, citations).map((s) =>
        s.kind === 'text' ? (
          <span key={s.start}>{s.text}</span>
        ) : (
          <CitationChip key={s.start} n={s.n} citation={s.citation} />
        ),
      )}
    </p>
  );
}
