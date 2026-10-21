import { Injectable } from '@nestjs/common';
import type { ExtractionHandler } from './extraction-handler.port';

/**
 * Stand-in until T2.9: does no extraction and completes at once, so the document goes
 * queued -> processing -> needs_review and the whole pipeline can be exercised. A document in
 * needs_review therefore has NO extracted data yet. T2.9 replaces this class.
 */
@Injectable()
export class PlaceholderExtractionHandler implements ExtractionHandler {
  extract(): Promise<void> {
    return Promise.resolve();
  }
}
