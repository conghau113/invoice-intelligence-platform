// Runs in the browser before the app becomes interactive (Next's client instrumentation file).
//
// Zod 4 compiles object schemas with `new Function` when it can, and finds out by trying
// `Function("")` the first time it parses. The CSP forbids eval in production (T7.4), so that probe
// is refused and reported as a violation on every page, even though Zod then falls back to its
// normal parser. `jitless` skips the probe. The setting lives on globalThis, so every copy of Zod
// in the page sees it; it must be set before the first parse, which this file is.
import { config } from 'zod';

config({ jitless: true });
