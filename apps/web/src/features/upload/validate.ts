// Must match MAX_UPLOAD_BYTES in apps/api (documents.module.ts). The server is the authority:
// this check only saves a doomed round trip and gives a quicker message.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// PDF, PNG, JPEG, XML (docs/architecture/SECURITY.md section 4).
const ALLOWED_TYPES: Readonly<Record<string, readonly string[]>> = {
  pdf: ['application/pdf'],
  png: ['image/png'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  xml: ['application/xml', 'text/xml'],
};

export const ACCEPT_ATTRIBUTE = Object.keys(ALLOWED_TYPES)
  .map((e) => `.${e}`)
  .join(',');

export type FileProblem = 'unsupportedType' | 'tooLarge' | 'empty';

/**
 * Name and declared MIME type are both attacker-controlled, so this is a convenience, not a check:
 * the API sniffs the real bytes. An empty `type` is common (the OS has no mapping) and allowed.
 */
export function validateFile(file: {
  name: string;
  size: number;
  type: string;
}): FileProblem | null {
  const dot = file.name.lastIndexOf('.');
  const mimes = dot < 0 ? undefined : ALLOWED_TYPES[file.name.slice(dot + 1).toLowerCase()];
  if (!mimes || (file.type !== '' && !mimes.includes(file.type))) return 'unsupportedType';
  if (file.size === 0) return 'empty';
  if (file.size > MAX_UPLOAD_BYTES) return 'tooLarge';
  return null;
}
