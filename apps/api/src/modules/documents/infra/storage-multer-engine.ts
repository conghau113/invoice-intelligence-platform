import { randomUUID } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { UnsupportedMediaTypeException } from '@nestjs/common';
import type { StoragePort } from '../../storage/application/storage.port';
import { detectFileType, SNIFF_BYTES, type SourceType } from '../domain/file-type';

/** What the controller receives as the uploaded "file" (multer merges these fields in). */
export interface UploadedObject {
  storageKey: string;
  size: number;
  sha256: string;
  sourceType: SourceType;
}

// The parts of multer's StorageEngine contract we use (@types/multer is not installed).
interface IncomingFile {
  stream: Readable;
}
type Done<T> = (error?: unknown, info?: T) => void;

const unsupported = (): UnsupportedMediaTypeException =>
  new UnsupportedMediaTypeException({
    message: 'Unsupported file type',
    code: 'UNSUPPORTED_FILE_TYPE',
  });

/**
 * Holds the first bytes back, decides the type, and only then lets anything through. A refused
 * file therefore never reaches the storage. Memory use is SNIFF_BYTES, not the file size.
 */
function sniffer(onDetected: (type: SourceType) => void): Transform {
  let head: Buffer[] = [];
  let held = 0;
  let decided = false;
  const decide = (done: (e?: Error) => void, push: (b: Buffer) => void): boolean => {
    const detected = detectFileType(Buffer.concat(head));
    if (!detected) {
      done(unsupported());
      return false;
    }
    onDetected(detected.sourceType);
    decided = true;
    push(Buffer.concat(head));
    head = [];
    return true;
  };
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      if (decided) return done(null, chunk);
      head.push(chunk);
      held += chunk.length;
      if (held < SNIFF_BYTES) return done();
      if (decide(done, (b) => this.push(b))) done();
    },
    flush(done) {
      // A file shorter than SNIFF_BYTES ends before the threshold; decide on what we have.
      if (decided) return done();
      if (decide(done, (b) => this.push(b))) done();
    },
  });
}

/**
 * Multer storage engine that streams the upload through the sniffer into StoragePort.put. The key
 * is server-generated from the caller's tenant; the client's file name is never used.
 */
export class StorageMulterEngine {
  constructor(private readonly storage: StoragePort) {}

  _handleFile(req: unknown, file: IncomingFile, cb: Done<UploadedObject>): void {
    const tenantId = (req as { user?: { tenantId: string } }).user?.tenantId;
    if (!tenantId)
      return cb(new Error('Upload reached the engine without an authenticated tenant'));

    let sourceType: SourceType | undefined;
    const checked = file.stream.pipe(sniffer((t) => (sourceType = t)));
    // put() attaches its own handlers a moment later (it awaits mkdir first); without a listener
    // now, a refusal in that gap is an unhandled 'error' event. put() still sees the error.
    checked.on('error', () => undefined);
    // pipe() does not forward errors: without this the sniffer's refusal would never stop the put.
    file.stream.on('error', (e) => checked.destroy(e));

    const storageKey = `tenant/${tenantId}/${randomUUID()}`;
    // then(onOk, onErr), not then().catch(): a throw inside cb must not call cb a second time.
    this.storage.put(storageKey, checked).then(
      ({ size, sha256 }) => {
        if (!sourceType) return cb(unsupported()); // unreachable: put succeeds only after detection
        cb(null, { storageKey, size, sha256, sourceType });
      },
      (e: unknown) => {
        // Drain what the client is still sending so the connection is not left hanging.
        file.stream.resume();
        cb(e);
      },
    );
  }

  _removeFile(_req: unknown, file: Partial<UploadedObject>, cb: (e: Error | null) => void): void {
    if (!file.storageKey) return cb(null);
    this.storage.delete(file.storageKey).then(
      () => cb(null),
      (e: unknown) => cb(e as Error),
    );
  }
}
