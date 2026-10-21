import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { STATUS_CODES } from 'node:http';
import { DocumentNotFoundError } from '../../modules/documents/domain/document-not-found.error';
import {
  INVALID_TRANSITION_CODE,
  InvalidDocumentTransitionError,
} from '../../modules/documents/domain/document-status';
import { JobNotFailedError } from '../../modules/queue/application/admin-jobs.service';

const KNOWN_CODES: ReadonlySet<string> = new Set([
  'FORBIDDEN_PERMISSION',
  'FORBIDDEN_UNDECLARED',
  'TENANT_REQUIRED',
  'TENANT_NOT_MEMBER',
  'UNSUPPORTED_FILE_TYPE',
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_KEY_REUSED',
  'QUEUE_UNAVAILABLE',
  INVALID_TRANSITION_CODE,
  'JOB_NOT_FAILED',
]);

/** Domain errors carry no HTTP knowledge; this is the one place that gives them a status. */
function domainProblem(
  e: unknown,
): { status: HttpStatus; code?: string; detail: string } | undefined {
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
  /** Stable machine-readable reason, only for codes set by our own guards. */
  code?: string;
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

  /** Only whitelisted codes are echoed, never a value derived from the request. */
  private codeOf(exception: unknown): string | undefined {
    if (!(exception instanceof HttpException)) return undefined;
    const response = exception.getResponse();
    if (typeof response !== 'object' || response === null) return undefined;
    const code = (response as { code?: unknown }).code;
    return typeof code === 'string' && KNOWN_CODES.has(code) ? code : undefined;
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
