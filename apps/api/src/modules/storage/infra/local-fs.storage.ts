import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  InvalidStorageKeyError,
  ObjectNotFoundError,
  type ObjectStat,
  type StoragePort,
  type StoredObject,
} from '../application/storage.port';

// One segment of plain characters; "." and ".." are refused separately.
const SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;

export class LocalFsStorage implements StoragePort {
  private readonly root: string;

  /** @param root absolute directory (DATA_DIR) */
  constructor(root: string) {
    if (!path.isAbsolute(root)) throw new Error('LocalFsStorage root must be absolute');
    this.root = path.resolve(root);
  }

  async put(key: string, data: Readable): Promise<StoredObject> {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });

    // Write to a sibling temp name and rename, so readers never see a half-written object.
    const temp = `${target}.${randomUUID()}.part`;
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        hash.update(chunk);
        size += chunk.length;
        done(null, chunk);
      },
    });
    try {
      await pipeline(data, meter, createWriteStream(temp, { flags: 'wx' }));
      await rename(temp, target);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
    return { key, size, sha256: hash.digest('hex') };
  }

  async get(key: string): Promise<Readable> {
    const target = this.resolve(key);
    if ((await this.stat(key)) === null) throw new ObjectNotFoundError();
    return createReadStream(target);
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async stat(key: string): Promise<ObjectStat | null> {
    try {
      const info = await stat(this.resolve(key));
      return info.isFile() ? { size: info.size } : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /** Validates every segment, then checks the resolved path is still inside the root. */
  private resolve(key: string): string {
    const segments = key.split('/');
    const ok = segments.every((s) => s !== '.' && s !== '..' && SEGMENT.test(s));
    if (!ok) throw new InvalidStorageKeyError();
    const target = path.resolve(this.root, ...segments);
    if (!target.startsWith(this.root + path.sep)) throw new InvalidStorageKeyError();
    return target;
  }
}
