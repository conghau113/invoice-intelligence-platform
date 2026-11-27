import { Writable } from 'node:stream';

/** Collects the JSON lines a logger writes (tests only). */
export function captureLines(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}
