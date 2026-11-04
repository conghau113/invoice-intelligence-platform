import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Readable } from 'node:stream';
import { isUuid } from '../../../common/uuid';
import { documents } from '../../../db/schema';
import { TenantDbService } from '../../../db/tenant-db.service';
import {
  ObjectNotFoundError,
  STORAGE_PORT,
  type StoragePort,
} from '../../storage/application/storage.port';
import { DocumentNotFoundError } from '../domain/document-not-found.error';
import { detectFileType, SNIFF_BYTES } from '../domain/file-type';

export interface DocumentFile {
  /** What the browser is told. XML is served as plain text, never as markup (see `contentTypeFor`). */
  contentType: string;
  stream: Readable;
}

/**
 * The type the response declares. The viewer shows XML as text, so it is sent as text/plain: if
 * the file were served as application/xml or text/html a browser could render or run it. PDF and
 * images keep their real type, decided from the bytes (the stored type is never user-supplied).
 */
export function contentTypeFor(sourceType: string, head: Buffer): string {
  if (sourceType === 'xml') return 'text/plain; charset=utf-8';
  const detected = detectFileType(head);
  return detected !== null && detected.sourceType === sourceType
    ? detected.mime
    : 'application/octet-stream';
}

/** The first chunk, then the rest. When the reader goes away (client disconnected) or the source fails, the file handle is closed. */
async function* chain(
  first: Buffer,
  rest: AsyncIterator<Buffer>,
  source: Readable,
): AsyncGenerator<Buffer> {
  try {
    yield first;
    for (let r = await rest.next(); r.done !== true; r = await rest.next()) yield r.value;
  } finally {
    source.destroy();
  }
}

@Injectable()
export class DocumentFileService {
  constructor(
    private readonly tenantDb: TenantDbService,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  /**
   * Looks the document up in the request's tenant transaction (RLS: another tenant's id is "not
   * found"), then opens the stored object through StoragePort. No public file URL exists (ADR 0017).
   */
  async open(id: string): Promise<DocumentFile> {
    if (!isUuid(id)) throw new DocumentNotFoundError();
    const [doc] = await this.tenantDb
      .current()
      .select({ sourceType: documents.sourceType, storageKey: documents.storageKey })
      .from(documents)
      .where(eq(documents.id, id));
    if (!doc) throw new DocumentNotFoundError();

    let source: Readable;
    try {
      source = await this.storage.get(doc.storageKey);
    } catch (e) {
      // The row exists but the bytes are gone: the caller sees the same 404, the cause is not leaked.
      if (e instanceof ObjectNotFoundError) throw new DocumentNotFoundError();
      throw e;
    }

    // Look at the first bytes to name the type, then hand them back in front of the rest.
    const it = source[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
    let first: IteratorResult<Buffer>;
    try {
      first = await it.next();
    } catch (e) {
      source.destroy();
      throw e;
    }
    const head = first.done === true ? Buffer.alloc(0) : first.value;
    return {
      contentType: contentTypeFor(doc.sourceType, head.subarray(0, SNIFF_BYTES)),
      stream: Readable.from(chain(head, it, source)),
    };
  }
}
