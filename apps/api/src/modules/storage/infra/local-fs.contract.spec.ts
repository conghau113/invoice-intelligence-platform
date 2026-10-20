import { describeStoragePortContract } from '../testing/storage-port.contract';
import { useTestRoots } from '../testing/test-root';
import { LocalFsStorage } from './local-fs.storage';

const newRoot = useTestRoots();
describeStoragePortContract('LocalFs', async () => new LocalFsStorage(await newRoot()));
