import { Button } from '@/components/ui/button';

// Server Component (no "use client"): rendered on the server, ships no JS of its own.
// TODO(T1.6): temporary hard-coded text; replace with next-intl keys in vi.json + en.json.
export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-2xl font-semibold">Invoice Intelligence Platform</h1>
      <Button>SAMPLE</Button>
    </main>
  );
}
