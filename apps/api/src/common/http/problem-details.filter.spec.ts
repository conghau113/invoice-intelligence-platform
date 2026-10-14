import { ArgumentsHost, BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { ProblemDetailsFilter } from './problem-details.filter';

function run(exception: unknown) {
  const res = {
    status: jest.fn().mockReturnThis(),
    type: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const req = { method: 'GET', path: '/x', originalUrl: '/x?q=Nguyen' };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
  } as unknown as ArgumentsHost;
  new ProblemDetailsFilter().catch(exception, host);
  return { res, body: res.json.mock.calls[0][0] };
}

describe('ProblemDetailsFilter', () => {
  let logError: jest.SpyInstance;
  beforeEach(() => {
    logError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
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

  it('hides the message of unknown errors behind a generic 500 and logs only metadata', () => {
    const { res, body } = run(new TypeError('secret PII: Nguyen Van A'));
    expect(res.status).toHaveBeenCalledWith(500);
    expect(body.detail).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('PII');
    expect(logError).toHaveBeenCalledWith('TypeError -> 500 on GET /x');
  });
});
