import { Readable } from 'node:stream';
import { describeStoragePortContract } from '../testing/storage-port.contract';
import { useTestRoots } from '../testing/test-root';
import { LocalFsStorage } from './local-fs.storage';

const newRoot = useTestRoots();
describeStoragePortContract('LocalFs', async () => new LocalFsStorage(await newRoot()));

// Beyond the shared contract: the root is the whole world of an instance.
describe('LocalFs roots', () => {
  it("two instances on different roots do not see each other's objects", async () => {
    const a = new LocalFsStorage(await newRoot());
    const b = new LocalFsStorage(await newRoot());
    await a.put('tenant/t1/obj', Readable.from([Buffer.from('x')]));
    expect(await a.stat('tenant/t1/obj')).toEqual({ size: 1 });
    expect(await b.stat('tenant/t1/obj')).toBeNull();
  });
});
