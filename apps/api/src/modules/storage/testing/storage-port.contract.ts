import { Readable } from 'node:stream';
import {
  InvalidStorageKeyError,
  ObjectNotFoundError,
  type StoragePort,
} from '../application/storage.port';

const HELLO_SHA256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const KEY = 'tenant/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222';

async function read(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Behaviour every StoragePort adapter must have. LocalFs runs it today; the SeaweedFS adapter
 * (O1) calls this same function with its own factory.
 * @param create returns a fresh, empty storage for each test
 */
export function describeStoragePortContract(
  name: string,
  create: () => Promise<StoragePort>,
): void {
  describe(`StoragePort contract: ${name}`, () => {
    let storage: StoragePort;
    beforeEach(async () => {
      storage = await create();
    });

    it('put then get returns the same bytes, with size and sha256', async () => {
      const stored = await storage.put(KEY, Readable.from([Buffer.from('hel'), Buffer.from('lo')]));
      expect(stored).toEqual({ key: KEY, size: 5, sha256: HELLO_SHA256 });
      expect(await read(await storage.get(KEY))).toBe('hello');
    });

    it('stat reports the size, and null for a missing key', async () => {
      await storage.put(KEY, Readable.from([Buffer.from('hello')]));
      expect(await storage.stat(KEY)).toEqual({ size: 5 });
      expect(await storage.stat('tenant/nobody/missing')).toBeNull();
    });

    it('get of a missing key throws ObjectNotFoundError', async () => {
      await expect(storage.get('tenant/nobody/missing')).rejects.toBeInstanceOf(
        ObjectNotFoundError,
      );
    });

    it('delete removes the object and is idempotent', async () => {
      await storage.put(KEY, Readable.from([Buffer.from('hello')]));
      await storage.delete(KEY);
      expect(await storage.stat(KEY)).toBeNull();
      await expect(storage.delete(KEY)).resolves.toBeUndefined();
    });

    it('put replaces an existing object', async () => {
      await storage.put(KEY, Readable.from([Buffer.from('first')]));
      await storage.put(KEY, Readable.from([Buffer.from('second')]));
      expect(await read(await storage.get(KEY))).toBe('second');
    });

    it('a failing stream stores nothing', async () => {
      const failing = new Readable({
        read() {
          this.push(Buffer.from('partial'));
          this.destroy(new Error('connection lost'));
        },
      });
      await expect(storage.put(KEY, failing)).rejects.toThrow('connection lost');
      expect(await storage.stat(KEY)).toBeNull();
    });

    it.each([
      '../../etc/passwd',
      'tenant/../../escape',
      '/etc/passwd',
      'tenant//double',
      'tenant/./x',
      '',
      'tenant/a\\..\\b',
      'tenant/a\0b',
    ])('rejects the unsafe key %j on every operation', async (bad) => {
      await expect(storage.put(bad, Readable.from([Buffer.from('x')]))).rejects.toBeInstanceOf(
        InvalidStorageKeyError,
      );
      await expect(storage.get(bad)).rejects.toBeInstanceOf(InvalidStorageKeyError);
      await expect(storage.delete(bad)).rejects.toBeInstanceOf(InvalidStorageKeyError);
      await expect(storage.stat(bad)).rejects.toBeInstanceOf(InvalidStorageKeyError);
    });
  });
}
