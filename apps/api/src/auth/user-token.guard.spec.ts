import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { mockDeep } from 'vitest-mock-extended';
import { loadConfig } from '../config/config.js';
import {
  type AuthenticatedRequest,
  UserTokenGuard,
} from './user-token.guard.js';

const guard = new UserTokenGuard(
  loadConfig({
    PORT: '3000',
    REDIS_URL: 'redis://localhost:6379',
    ADMIN_TOKEN: 'admin-token',
    DEMO_USERS: 'user-01:token-01,user-02:token-02',
  }),
);

function contextWith(headers: Record<string, string>) {
  const request = { headers } as unknown as AuthenticatedRequest;
  const context = mockDeep<ExecutionContext>();
  context.switchToHttp.mockReturnValue({
    getRequest: () => request,
  } as never);
  return { context, request };
}

describe('UserTokenGuard', () => {
  it("sets the user ID that belongs to the caller's token", () => {
    const { context, request } = contextWith({
      authorization: 'Bearer token-02',
    });

    expect(guard.canActivate(context)).toBe(true);
    expect(request.userId).toBe('user-02');
  });

  it('reads the scheme without regard to case, as HTTP defines it', () => {
    const { context, request } = contextWith({
      authorization: 'bearer token-01',
    });

    expect(guard.canActivate(context)).toBe(true);
    expect(request.userId).toBe('user-01');
  });

  it.each([
    ['no header', {}],
    ['text after the token', { authorization: 'Bearer token-01 more' }],
    ['another scheme', { authorization: 'Basic token-01' }],
    ['no token', { authorization: 'Bearer ' }],
    ['an unknown token', { authorization: 'Bearer token-99' }],
    // The admin credential is not a user.
    ['the admin token', { authorization: 'Bearer admin-token' }],
  ])('answers 401 for %s', (_case, headers) => {
    const { context, request } = contextWith(headers);

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(request.userId).toBeUndefined();
  });

  it('ignores a user ID the client sends', () => {
    // Identity comes from the credential only. A header naming another user
    // must not let one user spend, or read, another user's quota.
    const { context, request } = contextWith({
      authorization: 'Bearer token-01',
      'x-user-id': 'user-02',
    });

    guard.canActivate(context);

    expect(request.userId).toBe('user-01');
  });
});
