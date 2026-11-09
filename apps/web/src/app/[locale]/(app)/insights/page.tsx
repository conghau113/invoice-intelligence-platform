import { notFound } from 'next/navigation';
import { InsightsView } from '@/features/insights/insights-view';
import { loadInsights } from '@/features/insights/load-insights';
import { getMe } from '@/features/shell/me';

// The menu already hides this for roles without `insights:read`; a hand-typed URL gets the same
// translated 404 as any unknown page. The API refuses the numbers itself regardless.
export default async function InsightsPage() {
  const me = await getMe();
  if (me.kind !== 'ok' || !me.data.permissions.includes('insights:read')) notFound();
  return <InsightsView load={await loadInsights()} />;
}
