import { connection } from 'next/server';
import { Styleguide } from '@/features/styleguide/styleguide';

// Thin route: the page lives in features/styleguide. It reads the theme cookie, so it is per-request.
export default async function StyleguidePage() {
  await connection();
  return <Styleguide />;
}
