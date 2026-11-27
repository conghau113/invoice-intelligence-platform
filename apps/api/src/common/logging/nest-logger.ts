import type { LoggerService } from '@nestjs/common';
import { createLogger, type Logger, type LoggerOptions } from 'logger';

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** A stack trace Nest passes as the second argument of `error` ("Error: ...\n    at ..."). */
function isStack(value: unknown): value is string {
  return typeof value === 'string' && /\n[ \t]+at /.test(value);
}

/**
 * Nest's `Logger` facade on top of the shared pino logger (T7.2). Every `new Logger(context)` in the
 * code, and Nest's own start-up and error lines, end up here: JSON, ids for trace and tenant, PII
 * redacted (packages/logger). Request lines are not logged: the HTTP span already has them.
 */
export class NestPinoLogger implements LoggerService {
  readonly pino: Logger;

  constructor(options: LoggerOptions) {
    this.pino = createLogger(options);
  }

  log(message: unknown, ...params: unknown[]): void {
    this.write('info', message, params);
  }
  error(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params);
  }
  warn(message: unknown, ...params: unknown[]): void {
    this.write('warn', message, params);
  }
  debug(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }
  verbose(message: unknown, ...params: unknown[]): void {
    this.write('trace', message, params);
  }
  fatal(message: unknown, ...params: unknown[]): void {
    this.write('fatal', message, params);
  }

  /**
   * Nest calls `logger.warn(message, ...extra, context)`: a `Logger` created with a context
   * appends it as the last argument. `error` may also get a stack before the context.
   */
  private write(level: Level, message: unknown, params: unknown[]): void {
    const rest = [...params];
    const fields: Record<string, unknown> = {};
    if (rest.length > 0 && typeof rest.at(-1) === 'string' && !isStack(rest.at(-1))) {
      fields.context = rest.pop();
    }
    const stack = rest.find(isStack);
    if (stack !== undefined) fields.stack = stack;
    // `logger.warn('msg', { a: 1 }, 'Ctx')`: keep the other arguments (redacted like the rest).
    const extra = rest.filter((p) => p !== stack);
    if (extra.length > 0) fields.extra = extra;
    if (message instanceof Error) {
      this.pino[level]({ ...fields, err: message });
    } else if (message !== null && typeof message === 'object') {
      this.pino[level]({ ...fields, ...(message as Record<string, unknown>) });
    } else {
      this.pino[level](fields, String(message));
    }
  }
}
