'use client';

import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { isDocumentFailureCode, type Notification } from 'contracts';
import { Bell } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { formatDate } from '@/i18n/format';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';
import { coalesce } from '@/features/realtime/coalesce';
import { useNotificationEvents, useRealtimeStatus } from '@/features/realtime/realtime-provider';
import {
  badgeText,
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notificationsPollMs,
} from './notifications-client';

const KEY = ['notifications'] as const;
/** A burst of events (50 uploads finishing) reads the list a few times, not 50. */
const REFRESH_WAIT_MS = 300;
const REFRESH_MAX_WAIT_MS = 1_000;

/**
 * The bell in the top bar (T6.5). Its own query client: the shell is on every page, the documents
 * screens keep theirs. Both halves of delivery end here: the list read from the API (what was
 * stored while the user was away) and `notification.created` events while the tab is open, which
 * only say "read the list again". Without a socket the list is polled.
 */
export function NotificationBell() {
  const [client] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={client}>
      <BellMenu />
    </QueryClientProvider>
  );
}

export function BellMenu() {
  const t = useTranslations('Notifications');
  const client = useQueryClient();
  const live = useRealtimeStatus() === 'connected';
  const [open, setOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  const query = useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => fetchNotifications(signal),
    refetchInterval: notificationsPollMs(live),
    retry: 1,
  });

  const refresh = useMemo(
    () =>
      coalesce(
        () => void client.invalidateQueries({ queryKey: KEY }),
        REFRESH_WAIT_MS,
        REFRESH_MAX_WAIT_MS,
      ),
    [client],
  );
  useEffect(() => () => refresh.cancel(), [refresh]);
  useNotificationEvents(
    () => {
      refresh.call();
      setAnnouncement(t('announce'));
    },
    () => refresh.call(),
  );

  const afterWrite = { onSettled: () => client.invalidateQueries({ queryKey: KEY }) };
  const readOne = useMutation({ mutationFn: markNotificationRead, ...afterWrite });
  const readAll = useMutation({ mutationFn: markAllNotificationsRead, ...afterWrite });

  const unread = query.data?.unreadCount ?? 0;
  const failedWrite = readOne.isError || readAll.isError;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="relative"
            data-testid="notification-bell"
            aria-label={unread > 0 ? t('bellUnread', { count: unread }) : t('bell')}
          >
            <Bell aria-hidden className="size-5" />
            {unread > 0 && (
              <span
                aria-hidden
                data-testid="notification-badge"
                className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] leading-none font-semibold text-white"
              >
                {badgeText(unread)}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[min(22rem,calc(100vw-2rem))] p-0" data-testid="notifications">
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <h2 className="text-sm font-semibold">{t('title')}</h2>
            {unread > 0 && (
              <Button
                variant="ghost"
                size="xs"
                data-testid="notifications-read-all"
                disabled={readAll.isPending}
                onClick={() => readAll.mutate()}
              >
                {t('readAll')}
              </Button>
            )}
          </div>
          {failedWrite && (
            <p role="alert" className="border-b px-3 py-2 text-xs text-destructive">
              {t('writeError')}
            </p>
          )}
          <NotificationList
            state={query}
            onOpenItem={(n) => {
              if (n.readAt === null) readOne.mutate(n.id);
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
      {/* Screen readers hear that something arrived without the focus moving. */}
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </>
  );
}

export function NotificationList({
  state,
  onOpenItem,
}: Readonly<{
  state: ReturnType<typeof useQuery<Awaited<ReturnType<typeof fetchNotifications>>>>;
  onOpenItem: (n: Notification) => void;
}>) {
  const t = useTranslations('Notifications');
  if (state.isPending) return <Message>{t('loading')}</Message>;
  if (state.isError) return <Message>{t('loadError')}</Message>;
  if (state.data.items.length === 0) return <Message>{t('empty')}</Message>;
  return (
    <ul className="max-h-96 overflow-y-auto" data-testid="notification-list">
      {state.data.items.map((n) => (
        <li key={n.id} className="border-b last:border-b-0">
          <NotificationItem n={n} onOpen={() => onOpenItem(n)} />
        </li>
      ))}
    </ul>
  );
}

function NotificationItem({ n, onOpen }: Readonly<{ n: Notification; onOpen: () => void }>) {
  const t = useTranslations('Notifications');
  const tFailure = useTranslations('DocumentDetail.failure');
  const locale = useLocale();
  const unread = n.readAt === null;
  const reason =
    n.kind === 'extraction_failed'
      ? tFailure(isDocumentFailureCode(n.failureCode) ? n.failureCode : 'unknown')
      : null;
  return (
    <Link
      href={`/documents/${n.documentId}`}
      onClick={onOpen}
      data-testid="notification-item"
      data-unread={unread}
      className="flex gap-2 px-3 py-2 text-sm outline-none hover:bg-muted focus-visible:bg-muted"
    >
      <span
        aria-hidden
        className={cn(
          'mt-1.5 size-2 flex-none rounded-full',
          unread ? 'bg-primary' : 'bg-transparent',
        )}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={cn(unread && 'font-medium')}>
          {t(n.kind)}
          {unread && <span className="sr-only">{` (${t('unread')})`}</span>}
        </span>
        {reason !== null && (
          <span className="line-clamp-2 text-xs text-muted-foreground">{reason}</span>
        )}
        <time dateTime={n.createdAt} className="text-xs text-muted-foreground">
          {formatDate(n.createdAt, locale, { dateStyle: 'medium', timeStyle: 'short' })}
        </time>
      </span>
    </Link>
  );
}

function Message({ children }: Readonly<{ children: string }>) {
  return <p className="px-3 py-6 text-center text-sm text-muted-foreground">{children}</p>;
}
