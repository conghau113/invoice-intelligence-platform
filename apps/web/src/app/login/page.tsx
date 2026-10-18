import { LoginButton } from './login-button';

// TODO(T1.6): temporary hard-coded text; replace with next-intl keys in vi.json + en.json.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; tenant?: string }>;
}) {
  const { callbackUrl, tenant } = await searchParams;
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-2xl font-semibold">Invoice Intelligence Platform</h1>
      <LoginButton callbackUrl={callbackUrl} tenant={tenant} />
    </main>
  );
}
