import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { isApiErrorCode, type ApiErrorCode } from 'contracts';
import type { Request, Response } from 'express';
import { STATUS_CODES } from 'node:http';
import {
  InvalidQueryError,
  INVALID_QUERY,
} from '../../modules/documents/domain/document-list-query';
import { DocumentNotFoundError } from '../../modules/documents/domain/document-not-found.error';
import {
  DocumentVersionConflictError,
  INVALID_TRANSITION_CODE,
  InvalidDocumentTransitionError,
  VERSION_CONFLICT_CODE,
} from '../../modules/documents/domain/document-status';
import { ExtractionDataInvalidError } from '../../modules/extraction/domain/ai-errors';
import { JobNotFailedError } from '../../modules/queue/application/admin-jobs.service';
import { ExtractionMissingError } from '../../modules/review/domain/review-errors';
import { QaModelUnavailableError } from '../../modules/qa/application/qa-model.port';
import { QueryEmbeddingUnavailableError } from '../../modules/search/application/query-embedder.port';

/**
 * body-parser fails before any route runs, with an error that is not a Nest HttpException: a client
 * mistake (too large, not JSON, wrong charset) has a 4xx `status` and a `type`. Its message may quote
 * the body, so only the status is used.
 */
const bodyParserStatus = (e: unknown): number | undefined => {
  if (typeof e !== 'object' || e === null) return undefined;
  const { type, status } = e as { type?: unknown; status?: unknown };
  return typeof type === 'string' && typeof status === 'number' && status >= 400 && status < 500
    ? status
    : undefined;
};

/** Domain errors carry no HTTP knowledge; this is the one place that gives them a status. */
function domainProblem(
  e: unknown,
): { status: HttpStatus; code?: ApiErrorCode; detail: string } | undefined {
  if (e instanceof DocumentNotFoundError) {
    return { status: HttpStatus.NOT_FOUND, detail: 'Document not found' };
  }
  if (e instanceof InvalidDocumentTransitionError) {
    return {
      status: HttpStatus.CONFLICT,
      code: INVALID_TRANSITION_CODE,
      detail: 'The document is not in a state that allows this',
    };
  }
  const parserStatus = bodyParserStatus(e);
  if (parserStatus === HttpStatus.PAYLOAD_TOO_LARGE) {
    return {
      status: parserStatus,
      code: 'BODY_TOO_LARGE',
      detail: 'The request body is too large',
    };
  }
  if (parserStatus !== undefined) {
    return { status: parserStatus, code: 'BODY_INVALID', detail: 'The request body is invalid' };
  }
  if (e instanceof DocumentVersionConflictError) {
    return {
      status: HttpStatus.CONFLICT,
      code: VERSION_CONFLICT_CODE,
      detail: 'The document has changed since it was loaded',
    };
  }
  if (e instanceof ExtractionMissingError) {
    return { status: HttpStatus.CONFLICT, code: e.code, detail: 'The document has no extraction' };
  }
  if (e instanceof InvalidQueryError) {
    return {
      status: HttpStatus.BAD_REQUEST,
      code: INVALID_QUERY,
      detail: 'Invalid query parameters',
    };
  }
  if (e instanceof ExtractionDataInvalidError) {
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: e.code,
      detail: 'Stored extraction is invalid',
    };
  }
  // Retrieval (T5.3) or a Q&A model step (T5.4): the AI service could not answer.
  if (e instanceof QueryEmbeddingUnavailableError || e instanceof QaModelUnavailableError) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'AI_SERVICE_UNAVAILABLE',
      detail: 'The AI service is unavailable, try again',
    };
  }
  if (e instanceof JobNotFailedError) {
    return { status: HttpStatus.CONFLICT, code: 'JOB_NOT_FAILED', detail: 'The job is not failed' };
  }
  return undefined;
}

/** RFC 9457 Problem Details body. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  /** Stable machine-readable reason, only from the list in `contracts`. */
  code?: ApiErrorCode;
}

/**
 * Turns every thrown error into application/problem+json.
 *
 * Nothing request- or error-derived beyond the path is echoed back: the query string and the
 * original message of unknown or 5xx errors may contain document content or PII. For the same
 * reason the logger records only the error class, status, method and path.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();

    const domain = domainProblem(exception);
    const isHttp = exception instanceof HttpException;
    const status =
      domain?.status ?? (isHttp ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR);
    const title = STATUS_CODES[status] ?? 'Error';

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      const name = exception instanceof Error ? exception.constructor.name : typeof exception;
      this.logger.error(`${name} -> ${status} on ${req.method} ${req.path}`);
    }

    const body: ProblemDetails = {
      type: 'about:blank',
      title,
      status,
      detail: domain?.detail ?? this.detailOf(exception, status),
      instance: req.path,
    };
    const code = domain ? domain.code : this.codeOf(exception);
    if (code !== undefined) body.code = code;

    res.status(status).type('application/problem+json').json(body);
  }

  /** Only codes from the list in `contracts` are echoed, never a value derived from the request. */
  private codeOf(exception: unknown): ApiErrorCode | undefined {
    if (!(exception instanceof HttpException)) return undefined;
    const response = exception.getResponse();
    if (typeof response !== 'object' || response === null) return undefined;
    const code = (response as { code?: unknown }).code;
    return isApiErrorCode(code) ? code : undefined;
  }

  private detailOf(exception: unknown, status: number): string {
    if (!(exception instanceof HttpException) || status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      return 'Internal server error';
    }
    // Nest's built-in 404 message is "Cannot GET <url incl. query>", so don't pass it through.
    if (status === HttpStatus.NOT_FOUND && /^Cannot [A-Z]+ /.test(exception.message)) {
      return 'Resource not found';
    }
    const response = exception.getResponse();
    if (typeof response === 'string') return response;
    const message = (response as { message?: unknown }).message;
    if (Array.isArray(message)) return message.join('; ');
    return typeof message === 'string' ? message : exception.message;
  }
}
