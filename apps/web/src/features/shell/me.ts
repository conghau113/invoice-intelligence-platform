import 'server-only';
import { cache } from 'react';
import { apiGet } from '@/lib/api';

/** Shape of GET /auth/me. */
export interface Me {
  userId: string;
  tenantId: string;
  roles: string[];
  tenants: string[];
  permissions: string[];
}

/** One call per request even though the layout and the page both ask. */
export const getMe = cache(() => apiGet<Me>('/auth/me'));
