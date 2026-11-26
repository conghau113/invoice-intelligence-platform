import { Global, Module } from '@nestjs/common';
import { TracingShutdown } from './tracing-shutdown';

/**
 * Global on purpose: Nest shuts global modules down last, after every feature module, so the spans
 * of the jobs a worker finishes during shutdown are still exported. As a provider of the root
 * module it would run first, or alongside the worker (hooks of one module run in parallel).
 */
@Global()
@Module({ providers: [TracingShutdown] })
export class TracingModule {}
