import type { Request } from 'express';
import type { AuthUser } from '../domain/auth-user';

export type AuthenticatedRequest = Request & { user?: AuthUser };
