import { notFound } from 'next/navigation';
import { AskScreen } from '@/features/qa/ask-screen';
import { getMe } from '@/features/shell/me';

// The menu already hides this without `qa:ask` (also on the read-only demo, ADR 0018); a typed URL
// gets the same translated 404 as any unknown page. The API refuses the question itself regardless.
export default async function AskPage() {
  const me = await getMe();
  if (me.kind !== 'ok' || !me.data.permissions.includes('qa:ask')) notFound();
  return <AskScreen />;
}
