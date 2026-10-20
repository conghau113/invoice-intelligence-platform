import { detectFileType } from './file-type';

const bytes = (...parts: (string | number[])[]): Buffer =>
  Buffer.concat(
    parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))),
  );

describe('detectFileType', () => {
  it.each([
    ['pdf', bytes('%PDF-1.7\n'), 'pdf', 'application/pdf'],
    ['png', bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'rest'), 'image', 'image/png'],
    ['jpeg', bytes([0xff, 0xd8, 0xff, 0xe0], 'JFIF'), 'image', 'image/jpeg'],
    ['xml declaration', bytes('<?xml version="1.0"?><HDon/>'), 'xml', 'application/xml'],
    [
      'xml with BOM and blank lines',
      bytes([0xef, 0xbb, 0xbf], '\r\n  <?xml v'),
      'xml',
      'application/xml',
    ],
    ['xml without declaration', bytes('<HDon><DLHDon/></HDon>'), 'xml', 'application/xml'],
  ])('recognises %s', (_name, header, sourceType, mime) => {
    expect(detectFileType(header)).toEqual({ sourceType, mime });
  });

  it.each([
    ['a Windows executable (MZ)', bytes('MZ\x90\x00\x03\x00')],
    ['an ELF binary', bytes([0x7f], 'ELF')],
    ['a zip', bytes('PK\x03\x04')],
    ['plain text', bytes('hello world')],
    ['HTML-ish text that is not a tag', bytes('< 5 and > 3')],
    ['HTML', bytes('<!DOCTYPE html><html>')],
    ['an html tag', bytes('  <HTML><body>')],
    ['SVG', bytes('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['a script tag', bytes('<script>alert(1)</script>')],
    ['an empty file', Buffer.alloc(0)],
    ['a truncated PDF signature', bytes('%PD')],
  ])('refuses %s', (_name, header) => {
    expect(detectFileType(header)).toBeNull();
  });
});
