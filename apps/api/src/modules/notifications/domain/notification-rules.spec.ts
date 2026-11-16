import { DOCUMENT_STATUSES, canTransition } from '../../documents/domain/document-status';
import { notificationKindFor } from './notification-rules';

describe('notificationKindFor', () => {
  it('tells the uploader when an extraction ends', () => {
    expect(notificationKindFor('processing', 'needs_review')).toBe('extraction_succeeded');
    expect(notificationKindFor('processing', 'failed')).toBe('extraction_failed');
  });

  it('stays silent on every other valid transition', () => {
    const silent = DOCUMENT_STATUSES.flatMap((from) =>
      DOCUMENT_STATUSES.filter((to) => canTransition(from, to)).map((to) => [from, to] as const),
    ).filter(
      ([from, to]) => !(from === 'processing' && (to === 'needs_review' || to === 'failed')),
    );

    // Guards the test itself: the state machine has more edges than the two above.
    expect(silent.length).toBeGreaterThan(5);
    for (const [from, to] of silent) expect(notificationKindFor(from, to)).toBeNull();
  });
});
