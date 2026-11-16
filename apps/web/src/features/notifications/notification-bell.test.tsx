import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { NotificationPage } from 'contracts';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import en from '../../../messages/en.json';
import vi_ from '../../../messages/vi.json';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { BellMenu, NotificationList } from './notification-bell';

const DOC = '0b6f6c1e-8f4b-4c55-9f0e-6f1d8a1b2c3d';
const page = (unreadCount: number): NotificationPage => ({
  items: [
    {
      id: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
      kind: 'extraction_failed',
      documentId: DOC,
      failureCode: 'PDF_INVALID',
      createdAt: '2026-11-16T03:04:05.678Z',
      readAt: null,
    },
    {
      id: '2c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
      kind: 'extraction_succeeded',
      documentId: DOC,
      failureCode: null,
      createdAt: '2026-11-16T02:00:00.000Z',
      readAt: '2026-11-16T02:10:00.000Z',
    },
  ],
  meta: { page: 1, limit: 20, total: 2, totalPages: 1 },
  unreadCount,
});

function withProviders(node: ReactNode, data?: NotificationPage, locale: 'en' | 'vi' = 'en') {
  const client = new QueryClient();
  if (data !== undefined) client.setQueryData(['notifications'], data);
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : vi_}>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

/** The list as it renders for a query in a given state (the query reads the seeded cache). */
function List() {
  const state = useQuery<NotificationPage>({
    queryKey: ['notifications'],
    queryFn: () => new Promise(() => undefined),
  });
  return <NotificationList state={state} onOpenItem={() => undefined} />;
}

describe('BellMenu', () => {
  it('shows the unread count on the badge and in the label', () => {
    const html = withProviders(<BellMenu />, page(3));
    expect(html).toContain('aria-label="Notifications (3 unread)"');
    expect(html).toMatch(/data-testid="notification-badge"[^>]*>3</);
  });

  it('caps the badge at 99+', () => {
    expect(withProviders(<BellMenu />, page(120))).toMatch(/notification-badge"[^>]*>99\+</);
  });

  it('has no badge when everything is read', () => {
    const html = withProviders(<BellMenu />, page(0));
    expect(html).toContain('aria-label="Notifications"');
    expect(html).not.toContain('notification-badge');
  });

  it('labels the bell in Vietnamese', () => {
    expect(withProviders(<BellMenu />, page(2), 'vi')).toContain(
      'aria-label="Thông báo (2 chưa đọc)"',
    );
  });
});

describe('NotificationList', () => {
  it('links each notification to its document, unread first marked, with the failure reason', () => {
    const html = withProviders(<List />, page(1));
    expect(html.match(new RegExp(`href="/documents/${DOC}"`, 'g'))).toHaveLength(2);
    expect(html).toContain('Extraction failed');
    expect(html).toContain(en.DocumentDetail.failure.PDF_INVALID);
    expect(html).toContain('Extraction finished, the document is ready for review');
    expect(html).toContain('data-unread="true"');
    expect(html).toContain('data-unread="false"');
    expect(html).toContain('dateTime="2026-11-16T03:04:05.678Z"');
  });

  it('says so when there is nothing', () => {
    const html = withProviders(<List />, { ...page(0), items: [] }, 'vi');
    expect(html).toContain('Chưa có thông báo nào.');
  });

  it('says it is loading before the first answer', () => {
    expect(withProviders(<List />)).toContain('Loading notifications…');
  });
});
