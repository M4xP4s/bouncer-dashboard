import type { UsersPage, UsersQuery } from '@app/contracts';

export const FIRST_PAGE = 1;
/** The API refuses a longer search with 400. */
export const SEARCH_MAX_LENGTH = 64;

export const DEFAULT_USERS_QUERY: UsersQuery = {
  page: FIRST_PAGE,
  pageSize: 50,
  search: '',
  status: 'any',
  active: 'any',
  sort: 'closest',
};

export const sameQuery = (a: UsersQuery, b: UsersQuery): boolean =>
  a.page === b.page &&
  a.pageSize === b.pageSize &&
  a.search === b.search &&
  a.status === b.status &&
  a.active === b.active &&
  a.sort === b.sort;

/** The number of the last page; 1 when nothing matches. */
export const lastPage = (page: UsersPage): number =>
  Math.max(FIRST_PAGE, Math.ceil(page.total / page.pageSize));
