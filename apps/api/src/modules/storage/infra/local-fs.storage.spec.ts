import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { InvalidStorageKeyError } from '../application/storage.port';
import { useTestRoots } from '../testing/test-root';
import { LocalFsStorage } from './local-fs.storage';

const newRoot = useTestRoots();

async function listAll(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.map(String).sort();
}

describe('LocalFsStorage', () => {
  it('requires an absolute root', () => {
    expect(() => new LocalFsStorage('relative/dir')).toThrow(/absolute/);
  });

  it('a traversal key writes nothing anywhere, inside or outside the root', async () => {
    const parent = await newRoot();
    const root = path.join(parent, 'data');
    const storage = new LocalFsStorage(root);
    await expect(
      storage.put('../../etc/passwd', Readable.from([Buffer.from('x')])),
    ).rejects.toBeInstanceOf(InvalidStorageKeyError);
    expect(await listAll(parent)).toEqual([]);
  });

  it('stores under the root at the key path, with no temp file left over', async () => {
    const root = await newRoot();
    const storage = new LocalFsStorage(root);
    await storage.put('tenant/t1/obj', Readable.from([Buffer.from('hello')]));
    expect(await listAll(root)).toEqual([
      'tenant',
      path.join('tenant', 't1'),
      path.join('tenant', 't1', 'obj'),
    ]);
  });

  it('a failed put leaves no temp file behind', async () => {
    const root = await newRoot();
    const storage = new LocalFsStorage(root);
    const failing = new Readable({
      read() {
        this.destroy(new Error('boom'));
      },
    });
    await expect(storage.put('tenant/t1/obj', failing)).rejects.toThrow('boom');
    expect(await listAll(root)).toEqual(['tenant', path.join('tenant', 't1')]);
  });

  it('a directory is not an object', async () => {
    const root = await newRoot();
    const storage = new LocalFsStorage(root);
    await storage.put('tenant/t1/obj', Readable.from([Buffer.from('x')]));
    expect(await storage.stat('tenant/t1')).toBeNull();
  });
});
