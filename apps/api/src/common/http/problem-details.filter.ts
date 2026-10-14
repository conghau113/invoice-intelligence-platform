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

/** RFC 9457 Problem Details body. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
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

    const isHttp = exception instanceof HttpException;
    const status = isHttp ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const title = STATUS_CODES[status] ?? 'Error';

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      const name = exception instanceof Error ? exception.constructor.name : typeof exception;
      this.logger.error(`${name} -> ${status} on ${req.method} ${req.path}`);
    }

    const body: ProblemDetails = {
      type: 'about:blank',
      title,
      status,
      detail: this.detailOf(exception, status),
      instance: req.path,
    };

    res.status(status).type('application/problem+json').json(body);
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
