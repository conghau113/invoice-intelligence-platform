import { notFound } from 'next/navigation';

// Unknown URLs inside a locale reach not-found.tsx of [locale] (translated) instead of the
// global, untranslated 404.
export default function CatchAll(): never {
  notFound();
}
