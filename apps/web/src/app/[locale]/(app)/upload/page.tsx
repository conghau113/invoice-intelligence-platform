import { notFound } from 'next/navigation';
import { UploadScreen } from '@/features/upload/upload-screen';
import { getMe } from '@/features/shell/me';

// The menu already hides this for roles without `document:create`; a hand-typed URL gets the same
// translated 404 as any unknown page. The API refuses the upload itself regardless.
export default async function UploadPage() {
  const me = await getMe();
  if (me.kind !== 'ok' || !me.data.permissions.includes('document:create')) notFound();
  return <UploadScreen />;
}
