import { notFound } from 'next/navigation';
import { DocumentsScreen } from '@/features/documents/documents-screen';
import { getMe } from '@/features/shell/me';

// The menu already hides this for roles without `document:read`; a hand-typed URL gets the same
// translated 404 as any unknown page. The API refuses the list itself regardless.
export default async function DocumentsPage() {
  const me = await getMe();
  if (me.kind !== 'ok' || !me.data.permissions.includes('document:read')) notFound();
  return <DocumentsScreen />;
}
