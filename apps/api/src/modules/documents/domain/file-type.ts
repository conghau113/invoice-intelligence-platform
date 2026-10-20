export const SOURCE_TYPES = ['pdf', 'image', 'xml'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export interface DetectedFileType {
  sourceType: SourceType;
  mime: string;
}

/** Bytes the detector needs; the upload waits for this many (or end of file) before deciding. */
export const SNIFF_BYTES = 64;

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const UTF8_BOM = [0xef, 0xbb, 0xbf];

const startsWith = (b: Buffer, sig: readonly number[], at = 0): boolean =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

/**
 * Decides the type from the content only; the file name and the client's Content-Type are never
 * consulted (an .exe renamed .pdf starts with "MZ", so it matches nothing). XML is only a shallow
 * check here (optional BOM and whitespace, then `<?xml` or a tag); the real parse with XXE
 * protection is the parser's job (T2.8). UTF-16 XML is not accepted.
 */
export function detectFileType(header: Buffer): DetectedFileType | null {
  if (startsWith(header, [...Buffer.from('%PDF-')])) {
    return { sourceType: 'pdf', mime: 'application/pdf' };
  }
  if (startsWith(header, PNG)) return { sourceType: 'image', mime: 'image/png' };
  if (startsWith(header, [0xff, 0xd8, 0xff])) return { sourceType: 'image', mime: 'image/jpeg' };

  let i = startsWith(header, UTF8_BOM) ? UTF8_BOM.length : 0;
  while (i < header.length && [0x20, 0x09, 0x0a, 0x0d].includes(header[i] as number)) i++;
  const rest = header.subarray(i);
  const isXmlDecl = rest.subarray(0, 5).toString('latin1') === '<?xml';
  const isTag = rest[0] === 0x3c && /^[A-Za-z]$/.test(String.fromCharCode(rest[1] ?? 0));
  // Markup that is plainly not an invoice: HTML/SVG would otherwise be stored as "xml".
  const notInvoice = /^<(!doctype|html|svg|script)/i.test(rest.subarray(0, 16).toString('latin1'));
  return (isXmlDecl || isTag) && !notInvoice
    ? { sourceType: 'xml', mime: 'application/xml' }
    : null;
}
