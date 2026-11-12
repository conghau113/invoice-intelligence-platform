import { notFound } from 'next/navigation';
import { DocumentDetailScreen } from '@/features/documents/detail/document-detail-screen';
import { parseCitedFields } from '@/features/review/cited-fields';
import { getMe } from '@/features/shell/me';
import { isUuid } from '@/lib/uuid';

// Same rule as the list: a role without `document:read`, or an id that cannot be a document, gets
// the translated 404. The API refuses the read itself regardless.
export default async function DocumentDetailPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ id: string }>;
  searchParams: Promise<{ fields?: string | string[] }>;
}>) {
  const { id } = await params;
  // A Q&A citation opens the document with the fields it cited (T5.5).
  const citedFields = parseCitedFields((await searchParams).fields);
  const me = await getMe();
  if (!isUuid(id) || me.kind !== 'ok' || !me.data.permissions.includes('document:read')) {
    notFound();
  }
  // Editing the form needs the same permission as approving; a viewer sees it read-only.
  const canApprove = me.data.permissions.includes('document:approve');
  return <DocumentDetailScreen id={id} canApprove={canApprove} citedFields={citedFields} />;
}
