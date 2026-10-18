import { redirect } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { getSession } from '@/auth/session';

// Minimal landing page for T1.5; the real shell/menu is T1.7.
// TODO(T1.6): temporary hard-coded text; replace with next-intl keys in vi.json + en.json.
export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect('/login');
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p data-testid="tenant">{session.tenant ?? '-'}</p>
      <form action="/api/auth/logout" method="post">
        <Button type="submit" data-testid="logout">
          Sign out
        </Button>
      </form>
    </main>
  );
}
