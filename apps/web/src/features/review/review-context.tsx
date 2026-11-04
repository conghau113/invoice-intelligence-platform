'use client';

import { createContext, useContext } from 'react';
import type { WeakReason } from './weak-fields';

export interface ReviewContextValue {
  weak: ReadonlyMap<string, WeakReason[]>;
  readOnly: boolean;
  /** Fraction digits of the invoice currency (VND 0, USD 2): how money text maps to minor units. */
  fractionDigits: number;
  /** Plain text for one reason (translated; money formatted for the invoice currency). */
  reasonText: (reason: WeakReason) => string;
  /** The reviewer put the cursor in the field at `path`: the viewer jumps to its evidence. */
  onFocusPath: (path: string) => void;
  /** Translated message for a schema error (zod issue code). */
  errorText: (type: string | undefined) => string;
}

const Ctx = createContext<ReviewContextValue | null>(null);
export const ReviewProvider = Ctx.Provider;

export function useReview(): ReviewContextValue {
  const v = useContext(Ctx);
  if (v === null) throw new Error('useReview outside ReviewProvider');
  return v;
}
