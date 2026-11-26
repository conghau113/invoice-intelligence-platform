// Side-effect entry: imported first by worker.ts, so the instrumentations patch http/pg before Nest loads them.
import { startTracing } from './otel';

startTracing('invoice-worker');
