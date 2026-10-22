import { DOCUMENT_STATUSES, type DocumentStatus } from '@/components/common/status-badge';
import type { TransportResult, UploadRequest, UploadTransport } from './upload-queue';

export const UPLOAD_URL = '/api/documents/upload';

const isStatus = (v: unknown): v is DocumentStatus =>
  DOCUMENT_STATUSES.includes(v as DocumentStatus);

function parseJson(text: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * XMLHttpRequest, not fetch: fetch has no upload-progress events. Goes to our own Next route
 * (same origin, session cookie), which adds the bearer token and tenant; the browser never holds
 * the token. 201 = this call created the document, 200 = it already existed (same bytes or same key).
 */
export function createXhrTransport(url = UPLOAD_URL): UploadTransport {
  return {
    send(file, idempotencyKey, onProgress): UploadRequest {
      const xhr = new XMLHttpRequest();
      const result = new Promise<TransportResult>((resolve) => {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(e.loaded, e.total);
        };
        xhr.onabort = () => resolve({ kind: 'aborted' });
        xhr.onerror = () => resolve({ kind: 'error', failure: {} });
        xhr.onload = () => {
          const body = parseJson(xhr.responseText);
          if ((xhr.status === 200 || xhr.status === 201) && isStatus(body.status)) {
            if (typeof body.id === 'string') {
              resolve({
                kind: 'ok',
                created: xhr.status === 201,
                document: { id: body.id, status: body.status },
              });
              return;
            }
          }
          resolve({
            kind: 'error',
            failure: {
              status: xhr.status,
              code: typeof body.code === 'string' ? body.code : undefined,
            },
          });
        };
      });
      xhr.open('POST', url);
      xhr.setRequestHeader('Idempotency-Key', idempotencyKey);
      const form = new FormData();
      form.append('file', file); // the API reads the field named "file"
      xhr.send(form);
      return { result, abort: () => xhr.abort() };
    },
  };
}
