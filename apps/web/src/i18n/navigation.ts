import { createNavigation } from 'next-intl/navigation';
import { routing } from './routing';

// Locale-aware Link / useRouter / usePathname: use these instead of next/navigation in pages.
export const { Link, redirect, usePathname, useRouter } = createNavigation(routing);
