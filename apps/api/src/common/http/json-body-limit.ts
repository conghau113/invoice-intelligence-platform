import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, type RequestHandler } from 'express';

/**
 * A corrected invoice can be far over the default 100 KB: `fieldMeta` holds up to 500 characters of
 * evidence per field. Body parsing runs before the auth guards, so the larger limit is opened for
 * this one path only: everywhere else an anonymous caller still cannot make the server buffer and
 * parse more than the default.
 */
export const APPROVE_BODY_LIMIT = '1mb';

/**
 * Wrapped for two reasons. Nest skips its default JSON parser if it finds a middleware named
 * `jsonParser`, which is the name of the function `json()` returns, so mounting it directly would
 * leave every other route without a parser. And Nest turns a malformed-JSON SyntaxError into a 400
 * that keeps the message, which can quote the body; the replacement error carries only `type` and
 * `status`, for ProblemDetailsFilter.
 */
function approveBodyParser(): RequestHandler {
  const parse = json({ limit: APPROVE_BODY_LIMIT });
  return (req, res, next) => {
    parse(req, res, (err?: unknown) => {
      if (err === undefined || err === null) {
        next();
        return;
      }
      const { type, status } = err as { type?: unknown; status?: unknown };
      next(Object.assign(new Error('Request body refused'), { type, status }));
    });
  };
}

/** Before `app.init()`: this runs first, and the default parser then leaves a parsed body alone. */
export function applyJsonBodyLimit(app: NestExpressApplication): void {
  app.use('/documents/:id/approve', approveBodyParser());
}
