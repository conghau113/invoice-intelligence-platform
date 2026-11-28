// Side-effect entry: imported first by main.ts, so the instrumentations patch http/pg before Nest loads them.
import { startMetrics, startTracing } from './otel';

// Metrics first: the http instrumentation that startTracing registers records RED metrics into it.
startMetrics('invoice-api');
startTracing('invoice-api');
