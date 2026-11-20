import { expect, it } from 'vitest';
import type { UsersQuery } from '@app/contracts';
import { DEFAULT_USERS_QUERY, sameQuery } from './usersQuery.ts';

it('lists the closest to the limit first unless asked otherwise', () => {
  expect(DEFAULT_USERS_QUERY.sort).toBe('closest');
});

it('tells two queries apart when only their sort differs', () => {
  const byId: UsersQuery = { ...DEFAULT_USERS_QUERY, sort: 'id' };

  expect(sameQuery(DEFAULT_USERS_QUERY, byId)).toBe(false);
  expect(sameQuery(DEFAULT_USERS_QUERY, { ...DEFAULT_USERS_QUERY })).toBe(true);
});
