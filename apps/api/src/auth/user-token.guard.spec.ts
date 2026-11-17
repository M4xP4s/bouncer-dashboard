import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { mockDeep } from 'vitest-mock-extended';
import { StoreUnavailable } from '../rate-limit/rate-limit.store.js';
import { UserRegistry } from '../users/user-registry.js';
import {
  type AuthenticatedRequest,
  UserTokenGuard,
} from './user-token.guard.js';

const userIdByToken = new Map([
  ['token-01', 'user-01'],
  ['token-02', 'user-02'],
]);
const registry = mockDeep<UserRegistry>();
const guard = new UserTokenGuard(registry);

beforeEach(() => {
  registry.identify.mockReset();
  registry.identify.mockImplementation(
    async (token) => userIdByToken.get(token) ?? null,
  );
});

function contextWith(headers: Record<string, string>) {
  const request = { headers } as unknown as AuthenticatedRequest;
  const context = mockDeep<ExecutionContext>();
  context.switchToHttp.mockReturnValue({
    getRequest: () => request,
  } as never);
  return { context, request };
}

describe('UserTokenGuard', () => {
  it("sets the user ID the registry gives for the caller's token", async () => {
    const { context, request } = contextWith({
      authorization: 'Bearer token-02',
    });

    expect(await guard.canActivate(context)).toBe(true);
    expect(request.userId).toBe('user-02');
    expect(registry.identify).toHaveBeenCalledExactlyOnceWith('token-02');
  });

  it('reads the scheme without regard to case, as HTTP defines it', async () => {
    const { context, request } = contextWith({
      authorization: 'bearer token-01',
    });

    expect(await guard.canActivate(context)).toBe(true);
    expect(request.userId).toBe('user-01');
  });

  it.each([
    ['no header', {}],
    ['text after the token', { authorization: 'Bearer token-01 more' }],
    ['another scheme', { authorization: 'Basic token-01' }],
    ['no token', { authorization: 'Bearer ' }],
    ['an unknown token', { authorization: 'Bearer token-99' }],
  ])('answers 401 for %s', async (_case, headers) => {
    const { context, request } = contextWith(headers);

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(request.userId).toBeUndefined();
  });

  it('passes a registry outage on to the error filter, not as a 401', async () => {
    const outage = new StoreUnavailable(new Error('offline'));
    registry.identify.mockRejectedValue(outage);
    const { context, request } = contextWith({
      authorization: 'Bearer token-01',
    });

    await expect(guard.canActivate(context)).rejects.toBe(outage);
    expect(request.userId).toBeUndefined();
  });

  it('ignores a user ID the client sends', async () => {
    // Identity comes from the credential only. A header naming another user
    // must not let one user spend, or read, another user's quota.
    const { context, request } = contextWith({
      authorization: 'Bearer token-01',
      'x-user-id': 'user-02',
    });

    await guard.canActivate(context);

    expect(request.userId).toBe('user-01');
  });
});
