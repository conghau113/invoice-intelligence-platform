import type { HttpErrorCode } from 'contracts';
import { NextResponse } from 'next/server';

/** A failed answer from one of the web's own route handlers. The body is only a listed code. */
export const bffError = (code: HttpErrorCode, status: number): NextResponse =>
  NextResponse.json({ code }, { status });
