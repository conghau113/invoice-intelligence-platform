import { describe, expect, it } from 'vitest';
import {
  MAX_CONCURRENT_UPLOADS,
  UploadQueue,
  type TransportResult,
  type UploadTransport,
} from './upload-queue';
import { MAX_UPLOAD_BYTES } from './validate';

interface Call {
  file: File;
  key: string;
  aborted: boolean;
  progress: (loaded: number, total: number) => void;
  finish: (r: TransportResult) => void;
}

/** A transport the test drives by hand: nothing finishes until the test says so. */
function fakeTransport() {
  const calls: Call[] = [];
  let inFlight = 0;
  let peak = 0;
  const transport: UploadTransport = {
    send(file, key, progress) {
      let finish!: (r: TransportResult) => void;
      const result = new Promise<TransportResult>((res) => (finish = res));
      const call: Call = {
        file,
        key,
        aborted: false,
        progress,
        finish: (r) => {
          inFlight--;
          finish(r);
        },
      };
      inFlight++;
      peak = Math.max(peak, inFlight);
      calls.push(call);
      return {
        result,
        abort: () => {
          call.aborted = true;
          call.finish({ kind: 'aborted' });
        },
      };
    },
  };
  return { transport, calls, peak: () => peak };
}

const file = (name: string, size = 10) => new File([new Uint8Array(size)], name);
const ok = (created = true): TransportResult => ({
  kind: 'ok',
  created,
  document: { id: 'doc-1', status: 'queued' },
});
const tick = () => new Promise((r) => setTimeout(r, 0));
const state = (q: UploadQueue, name: string) => q.getSnapshot().find((i) => i.file.name === name)!;

describe('UploadQueue', () => {
  it('never runs more than 3 uploads at once and starts the next as one finishes', async () => {
    const { transport, calls, peak } = fakeTransport();
    const q = new UploadQueue(transport);
    q.add(['1', '2', '3', '4', '5'].map((n) => file(`${n}.pdf`)));
    expect(MAX_CONCURRENT_UPLOADS).toBe(3);
    expect(calls).toHaveLength(3);
    expect(state(q, '4.pdf').state).toBe('pending');

    calls[0]!.finish(ok());
    await tick();
    expect(calls).toHaveLength(4);
    calls[1]!.finish(ok());
    calls[2]!.finish(ok());
    await tick();
    expect(calls).toHaveLength(5);
    calls[3]!.finish(ok());
    calls[4]!.finish(ok());
    await tick();
    expect(q.getSnapshot().map((i) => i.state)).toEqual(Array(5).fill('done'));
    expect(peak()).toBe(3);
  });

  it('reports progress per file, never backwards, and 100 when done', async () => {
    const { transport, calls } = fakeTransport();
    const q = new UploadQueue(transport);
    q.add([file('a.pdf'), file('b.pdf')]);
    calls[0]!.progress(25, 100);
    calls[1]!.progress(1, 3);
    expect([state(q, 'a.pdf').progress, state(q, 'b.pdf').progress]).toEqual([25, 33]);
    calls[0]!.progress(10, 100); // out-of-order event
    calls[0]!.progress(500, 100); // more than total
    expect(state(q, 'a.pdf').progress).toBe(100);
    calls[0]!.finish(ok());
    await tick();
    expect(state(q, 'a.pdf')).toMatchObject({ state: 'done', progress: 100 });
    expect(state(q, 'b.pdf').progress).toBe(33);
  });

  it('one failing file does not stop the others', async () => {
    const { transport, calls } = fakeTransport();
    const q = new UploadQueue(transport);
    q.add(['1', '2', '3', '4', '5'].map((n) => file(`${n}.xml`)));
    calls[1]!.finish({ kind: 'error', failure: { status: 415, code: 'UNSUPPORTED_FILE_TYPE' } });
    await tick();
    for (const i of [0, 2, 3, 4]) {
      calls[i]!.finish(ok());
      await tick();
    }
    expect(q.getSnapshot().map((i) => i.state)).toEqual(['done', 'error', 'done', 'done', 'done']);
    expect(state(q, '2.xml')).toMatchObject({ errorKey: 'unsupportedType', retryable: false });
  });

  it('rejects invalid files without sending them and keeps the valid ones going', () => {
    const { transport, calls } = fakeTransport();
    const q = new UploadQueue(transport);
    q.add([file('ok.pdf'), file('bad.exe'), file('empty.pdf', 0)]);
    expect(calls.map((c) => c.file.name)).toEqual(['ok.pdf']);
    expect(state(q, 'bad.exe')).toMatchObject({ state: 'error', errorKey: 'unsupportedType' });
    expect(state(q, 'empty.pdf')).toMatchObject({ state: 'error', errorKey: 'empty' });
    const big = { name: 'big.pdf', size: MAX_UPLOAD_BYTES + 1, type: '' } as File;
    q.add([big]);
    expect(state(q, 'big.pdf').errorKey).toBe('tooLarge');
    expect(calls).toHaveLength(1);
  });

  it('cancels an upload in flight, frees its slot, and ignores its late result', async () => {
    const { transport, calls } = fakeTransport();
    const q = new UploadQueue(transport);
    q.add(['1', '2', '3', '4'].map((n) => file(`${n}.pdf`)));
    q.cancel(state(q, '1.pdf').id);
    expect(calls[0]!.aborted).toBe(true);
    expect(state(q, '1.pdf').state).toBe('cancelled');
    expect(calls).toHaveLength(4); // 4.pdf took the freed slot
    await tick();
    expect(state(q, '1.pdf').state).toBe('cancelled');
  });

  it('cancels a pending file so it never starts', () => {
    const { transport, calls } = fakeTransport();
    const q = new UploadQueue(transport);
    q.add(['1', '2', '3', '4'].map((n) => file(`${n}.pdf`)));
    q.cancel(state(q, '4.pdf').id);
    calls[0]!.finish(ok());
    expect(calls).toHaveLength(3);
    expect(state(q, '4.pdf').state).toBe('cancelled');
  });

  it('cancelAll aborts what is running and stops pending files from starting', () => {
    const { transport, calls } = fakeTransport();
    const q = new UploadQueue(transport);
    q.add(['1', '2', '3', '4'].map((n) => file(`${n}.pdf`)));
    q.cancelAll();
    expect(calls.slice(0, 3).every((c) => c.aborted)).toBe(true);
    expect(calls).toHaveLength(3); // the 4th never started
    expect(q.getSnapshot().map((i) => i.state)).toEqual(Array(4).fill('cancelled'));
    q.add([file('later.pdf')]); // the queue stays usable (React strict mode unmounts once)
    expect(calls).toHaveLength(4);
  });

  it('retries a failed file with the SAME idempotency key', async () => {
    const { transport, calls } = fakeTransport();
    const q = new UploadQueue(transport);
    q.add([file('a.pdf')]);
    calls[0]!.finish({ kind: 'error', failure: {} }); // network error
    await tick();
    expect(state(q, 'a.pdf')).toMatchObject({
      state: 'error',
      errorKey: 'network',
      retryable: true,
    });
    q.retry(state(q, 'a.pdf').id);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.key).toBe(calls[0]!.key);
    expect(state(q, 'a.pdf')).toMatchObject({ state: 'uploading', progress: 0 });
    calls[1]!.finish(ok());
    await tick();
    expect(state(q, 'a.pdf').state).toBe('done');
  });

  it('can retry a cancelled file, but not one the server will always refuse', async () => {
    const { transport, calls } = fakeTransport();
    const q = new UploadQueue(transport);
    q.add([file('a.pdf'), file('b.pdf')]);
    q.cancel(state(q, 'a.pdf').id);
    q.retry(state(q, 'a.pdf').id);
    expect(calls).toHaveLength(3);
    calls[1]!.finish({ kind: 'error', failure: { status: 415, code: 'UNSUPPORTED_FILE_TYPE' } });
    await tick();
    q.retry(state(q, 'b.pdf').id);
    expect(state(q, 'b.pdf').state).toBe('error');
    expect(calls).toHaveLength(3);
  });

  it('shows a 200 (document already existed) as duplicate, not as an error', async () => {
    const { transport, calls } = fakeTransport();
    const q = new UploadQueue(transport);
    q.add([file('a.pdf')]);
    calls[0]!.finish(ok(false));
    await tick();
    expect(state(q, 'a.pdf')).toMatchObject({ state: 'duplicate', document: { status: 'queued' } });
  });

  it('turns a transport that throws or rejects into a retryable error and keeps going', async () => {
    const calls: string[] = [];
    const transport: UploadTransport = {
      send(f) {
        calls.push(f.name);
        if (f.name === 'throws.pdf') throw new Error('boom');
        return { result: Promise.reject(new Error('rejected')), abort: () => undefined };
      },
    };
    const q = new UploadQueue(transport);
    q.add([file('throws.pdf'), file('rejects.pdf')]);
    await tick();
    expect(q.getSnapshot().map((i) => [i.state, i.errorKey])).toEqual([
      ['error', 'network'],
      ['error', 'network'],
    ]);
  });

  it('clearSettled keeps only unfinished and retryable rows', async () => {
    const { transport, calls } = fakeTransport();
    const q = new UploadQueue(transport);
    q.add([file('done.pdf'), file('net.pdf'), file('bad.exe'), file('run.pdf')]);
    calls[0]!.finish(ok());
    calls[1]!.finish({ kind: 'error', failure: {} });
    await tick();
    q.clearSettled();
    expect(
      q
        .getSnapshot()
        .map((i) => i.file.name)
        .sort(),
    ).toEqual(['net.pdf', 'run.pdf']);
  });

  it('gives each chosen file its own idempotency key', () => {
    const { transport, calls } = fakeTransport();
    const q = new UploadQueue(transport);
    q.add([file('a.pdf'), file('b.pdf')]);
    expect(new Set(calls.map((c) => c.key)).size).toBe(2);
  });

  it('notifies subscribers and hands out a stable snapshot between changes', () => {
    const { transport } = fakeTransport();
    const q = new UploadQueue(transport);
    let n = 0;
    const off = q.subscribe(() => n++);
    expect(q.getSnapshot()).toBe(q.getSnapshot());
    q.add([file('a.pdf')]);
    expect(n).toBeGreaterThan(0);
    off();
    const before = n;
    q.add([file('b.pdf')]);
    expect(n).toBe(before);
  });
});
