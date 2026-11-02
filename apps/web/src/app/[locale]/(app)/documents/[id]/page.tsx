import { notFound } from 'next/navigation';
import { DocumentDetailScreen } from '@/features/documents/detail/document-detail-screen';
import { getMe } from '@/features/shell/me';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same rule as the list: a role without `document:read`, or an id that cannot be a document, gets
// the translated 404. The API refuses the read itself regardless.
export default async function DocumentDetailPage({
  params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params;
  const me = await getMe();
  if (!UUID.test(id) || me.kind !== 'ok' || !me.data.permissions.includes('document:read')) {
    notFound();
  }
  return <DocumentDetailScreen id={id} />;
}
