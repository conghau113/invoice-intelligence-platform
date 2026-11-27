import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { API_ERROR_CODES } from 'contracts';
import { currentLogContext } from 'logger';
import { DocumentNotFoundError } from '../../modules/documents/domain/document-not-found.error';
import { InvalidDocumentTransitionError } from '../../modules/documents/domain/document-status';
import { JobNotFailedError } from '../../modules/queue/application/admin-jobs.service';
import { ProblemDetailsFilter } from './problem-details.filter';

function run(exception: unknown, extra: Record<string, unknown> = {}) {
  const res = {
    status: jest.fn().mockReturnThis(),
    type: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const req = { method: 'GET', path: '/x', originalUrl: '/x?q=Nguyen', ...extra };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
  } as unknown as ArgumentsHost;
  new ProblemDetailsFilter().catch(exception, host);
  return { res, body: res.json.mock.calls[0][0] };
}

describe('ProblemDetailsFilter', () => {
  let logError: jest.SpyInstance;
  let logWarn: jest.SpyInstance;
  beforeEach(() => {
    logError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    logWarn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('maps HttpException to problem+json with its status', () => {
    const { res, body } = run(new NotFoundException('Invoice not found'));
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.type).toHaveBeenCalledWith('application/problem+json');
    expect(body).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'Invoice not found',
      instance: '/x',
    });
    expect(logError).not.toHaveBeenCalled();
  });

  it('maps domain errors to 404 / 409 with fixed text', () => {
    const missing = run(new DocumentNotFoundError());
    expect(missing.res.status).toHaveBeenCalledWith(404);
    expect(missing.body.detail).toBe('Document not found');

    const bad = run(new InvalidDocumentTransitionError('failed', 'approved'));
    expect(bad.res.status).toHaveBeenCalledWith(409);
    expect(bad.body.code).toBe('INVALID_DOCUMENT_TRANSITION');
    expect(JSON.stringify(bad.body)).not.toContain('approved');

    expect(run(new JobNotFailedError()).body).toMatchObject({
      status: 409,
      code: 'JOB_NOT_FAILED',
    });
  });

  it('body-parser errors keep their 4xx status, a fixed text and no quote of the body', () => {
    const parserError = (type: string, status: number) =>
      Object.assign(new Error('Unexpected token in SAMPLE-SECRET'), { type, status });

    const tooLarge = run(parserError('entity.too.large', 413));
    expect(tooLarge.res.status).toHaveBeenCalledWith(413);
    expect(tooLarge.body.code).toBe('BODY_TOO_LARGE');

    const malformed = run(parserError('entity.parse.failed', 400));
    expect(malformed.res.status).toHaveBeenCalledWith(400);
    expect(malformed.body.code).toBe('BODY_INVALID');
    expect(JSON.stringify(malformed.body)).not.toContain('SAMPLE-SECRET');

    // A 5xx with the same shape is not a client mistake.
    expect(run(parserError('stream.encoding.set', 500)).res.status).toHaveBeenCalledWith(500);
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it('never echoes the query string, even for Nest built-in 404 messages', () => {
    const { body } = run(new NotFoundException('Cannot GET /x?q=Nguyen'));
    expect(JSON.stringify(body)).not.toContain('Nguyen');
    expect(body.instance).toBe('/x');
  });

  it('joins validation message arrays into detail', () => {
    const { body } = run(new BadRequestException(['a is required', 'b must be a number']));
    expect(body.status).toBe(400);
    expect(body.detail).toBe('a is required; b must be a number');
  });

  it.each(API_ERROR_CODES)('echoes %s, a code on the list in contracts', (code) => {
    expect(run(new ForbiddenException({ message: 'no', code })).body.code).toBe(code);
  });

  it('does not echo a code only the web sends: the API never answers with it', () => {
    const { body } = run(new ForbiddenException({ message: 'no', code: 'API_UNREACHABLE' }));
    expect(body).not.toHaveProperty('code');
  });

  it('echoes only whitelisted error codes', () => {
    const known = run(new ForbiddenException({ message: 'no', code: 'FORBIDDEN_PERMISSION' }));
    expect(known.body.code).toBe('FORBIDDEN_PERMISSION');
    const unknown = run(new ForbiddenException({ message: 'no', code: 'Nguyen Van A' }));
    expect(unknown.body).not.toHaveProperty('code');
  });

  it('hides the message of unknown errors behind a generic 500 and logs only metadata', () => {
    const { res, body } = run(new TypeError('secret PII: Nguyen Van A'));
    expect(res.status).toHaveBeenCalledWith(500);
    expect(body.detail).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('PII');
    expect(logError).toHaveBeenCalledWith('TypeError -> 500 on GET /x');
  });

  describe('log lines (T7.2)', () => {
    const TENANT = '00000000-0000-4000-8000-0000000000a1';
    const USER = '00000000-0000-4000-8000-0000000000b1';
    const user = { tenantId: TENANT, userId: USER };

    it('logs a refused request once: route template, code, ids; never the query', () => {
      run(new ForbiddenException({ message: 'no', code: 'FORBIDDEN_PERMISSION' }), {
        user,
        route: { path: '/documents/:id/approve' },
        method: 'POST',
        originalUrl: '/documents/1/approve?note=Nguyen',
      });
      expect(logWarn).toHaveBeenCalledTimes(1);
      expect(logWarn).toHaveBeenCalledWith({
        msg: 'request refused',
        status: 403,
        method: 'POST',
        route: '/documents/:id/approve',
        code: 'FORBIDDEN_PERMISSION',
        user_id: USER,
      });
      expect(JSON.stringify(logWarn.mock.calls)).not.toContain('Nguyen');
    });

    it.each([401, 429])('logs %i too, without a user when there is none', (status) => {
      run(new HttpException('x', status));
      expect(logWarn).toHaveBeenCalledWith(expect.objectContaining({ status, route: 'unmatched' }));
      expect(logWarn.mock.calls[0]?.[0]).not.toHaveProperty('user_id');
    });

    it('does not log an ordinary 4xx', () => {
      run(new NotFoundException('nope'));
      run(new BadRequestException('bad'));
      expect(logWarn).not.toHaveBeenCalled();
      expect(logError).not.toHaveBeenCalled();
    });

    it('writes the error line inside the tenant of the authenticated user', () => {
      let tenant: string | undefined;
      logError.mockImplementation(() => {
        tenant = currentLogContext().tenantId;
      });
      run(new TypeError('boom'), { user });
      expect(tenant).toBe(TENANT);
    });
  });
});
