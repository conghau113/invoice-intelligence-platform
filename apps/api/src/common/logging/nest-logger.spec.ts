import { Logger } from '@nestjs/common';
import { runWithLogContext } from 'logger';
import { captureLines } from './capture.testing';
import { withJobLogContext } from './job-log-context';
import { NestPinoLogger } from './nest-logger';

const TENANT = '00000000-0000-4000-8000-0000000000a1';

describe('NestPinoLogger behind Nest Logger', () => {
  let out: ReturnType<typeof captureLines>;
  beforeEach(() => {
    out = captureLines();
    Logger.overrideLogger(new NestPinoLogger({ service: 'invoice-api', destination: out.stream }));
  });
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose', 'fatal']));

  it('writes a JSON line with the Logger context, level and service', () => {
    new Logger('ProviderGuard').warn('circuit open: queue held 5000 ms');
    expect(out.lines()).toEqual([
      expect.objectContaining({
        service: 'invoice-api',
        level: 'warn',
        context: 'ProviderGuard',
        msg: 'circuit open: queue held 5000 ms',
      }),
    ]);
  });

  it('keeps a stack Nest passes to error, redacted', () => {
    const stack = 'Error: insert for jane@example.com\n    at x (y.ts:1:1)';
    new Logger('ExceptionHandler').error('failed for Nguyễn Văn Jane SAMPLE', stack);
    const [line] = out.lines();
    expect(line).toMatchObject({
      level: 'error',
      context: 'ExceptionHandler',
      msg: 'failed for [NAME]',
      stack: 'Error: insert for [EMAIL]\n    at x (y.ts:1:1)',
    });
  });

  it('spreads an object message and redacts its fields', () => {
    new Logger('Filter').warn({ msg: 'request refused', status: 403, buyerName: 'X' });
    expect(out.lines()[0]).toMatchObject({
      msg: 'request refused',
      status: 403,
      buyerName: '[REDACTED]',
    });
  });

  it('keeps extra arguments, redacted', () => {
    new Logger('Ctx').warn('msg', { a: 1, email: 'x' }, 'jane@example.com');
    expect(out.lines()[0]).toMatchObject({
      context: 'Ctx',
      msg: 'msg',
      extra: [{ a: 1, email: '[REDACTED]' }, '[EMAIL]'],
    });
  });

  it('turns an Error message into err data', () => {
    new Logger('Worker').error(new TypeError('bad 6904000855'));
    expect(out.lines()[0]).toMatchObject({ err: { type: 'TypeError', message: 'bad [TAX_CODE]' } });
  });

  it('tags lines with the tenant of the request or job', () => {
    const log = new Logger('T');
    runWithLogContext({ tenantId: TENANT }, () => log.log('in request'));
    withJobLogContext({ tenantId: TENANT, documentId: 'd' }, () => log.log('in job'));
    withJobLogContext({ tenantId: 'not-a-uuid' }, () => log.log('bad job data'));
    withJobLogContext(undefined, () => log.log('no job'));
    expect(out.lines().map((l) => l.tenant_id)).toEqual([TENANT, TENANT, undefined, undefined]);
  });
});
