import { contentTypeFor } from './document-file.service';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

describe('contentTypeFor', () => {
  it.each([
    ['pdf', Buffer.from('%PDF-1.7'), 'application/pdf'],
    ['image', PNG, 'image/png'],
    ['image', JPG, 'image/jpeg'],
    ['xml', Buffer.from('<?xml?>'), 'text/plain; charset=utf-8'],
    // Whatever the bytes are, XML never becomes markup.
    ['xml', Buffer.from('<html><script>'), 'text/plain; charset=utf-8'],
    // Stored as PDF but the bytes say PNG: do not trust either, send an opaque type.
    ['pdf', PNG, 'application/octet-stream'],
    ['image', Buffer.alloc(0), 'application/octet-stream'],
  ])('%s with these bytes -> %s', (sourceType, head, expected) => {
    expect(contentTypeFor(sourceType, head)).toBe(expected);
  });
});

describe('DocumentFileService.open closes the file when the reader leaves', () => {
  it('destroys the source stream when the returned stream is destroyed early', async () => {
    const { Readable } = await import('node:stream');
    const { DocumentFileService } = await import('./document-file.service');
    const source = Readable.from([Buffer.from('%PDF-1.7 a'), Buffer.from('b'), Buffer.from('c')]);
    const tx = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ sourceType: 'pdf', storageKey: 'k' }]),
        }),
      }),
    };
    const svc = new DocumentFileService(
      { current: () => tx } as never,
      { get: () => Promise.resolve(source) } as never,
    );
    const file = await svc.open('3f1c9a52-7d0e-4b7a-9c1d-2a6f0b8e4d11');
    expect(file.contentType).toBe('application/pdf');
    const reader = file.stream[Symbol.asyncIterator]();
    await reader.next();
    await reader.return?.(); // the client went away after the first chunk
    expect(source.destroyed).toBe(true);
  });
});
