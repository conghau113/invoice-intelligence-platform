import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, visibleNavItems } from './nav-items';

// Same permission lists the API returns from /auth/me for each role (apps/api permissions.ts).
const VIEWER = ['document:read', 'qa:ask', 'insights:read'];
const ACCOUNTANT = [...VIEWER, 'document:create', 'document:approve'];
const ADMIN = [...ACCOUNTANT, 'document:manage', 'tenant:manage'];
const ids = (p: string[]) => visibleNavItems(p).map((i) => i.id);

describe('visibleNavItems', () => {
  it('viewer sees no upload and no administration', () =>
    expect(ids(VIEWER)).toEqual(['documents', 'ask', 'insights']));
  it('accountant can upload but not manage members', () =>
    expect(ids(ACCOUNTANT)).toEqual(['documents', 'upload', 'ask', 'insights']));
  it('tenant admin sees everything', () => expect(ids(ADMIN)).toEqual(NAV_ITEMS.map((i) => i.id)));
  it('no permission, no menu (deny by default)', () => expect(ids([])).toEqual([]));
});
