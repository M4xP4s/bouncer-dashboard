import {
  ActionIcon,
  Group,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { type ReactNode, useId } from 'react';
import type { Status, UsersPage, UsersQuery } from '@app/contracts';
import {
  FIRST_PAGE,
  SEARCH_MAX_LENGTH,
  lastPage,
} from '../../api/usersQuery.ts';
import { utcTime } from '../../lib/time.ts';

/** The analytics read's number of users in all and in each status. */
export interface StatusCounts {
  all: number;
  byStatus: Record<Status, number>;
}

interface Option<T extends string> {
  value: T;
  label: string;
}

const STATUS_OPTIONS: Option<Status>[] = [
  { value: 'Exceeded', label: 'Exceeded' },
  { value: 'Warning', label: 'Warning' },
  { value: 'OK', label: 'OK' },
];

const ACTIVE_OPTIONS: Option<UsersQuery['active']>[] = [
  { value: 'any', label: 'Any time' },
  { value: '5m', label: 'Last 5 minutes' },
  { value: '1h', label: 'Last hour' },
  { value: '24h', label: 'Last 24 hours' },
];

const SORT_OPTIONS: Option<UsersQuery['sort']>[] = [
  { value: 'closest', label: 'Closest to limit' },
  { value: 'id', label: 'User ID' },
];

const PAGE_SIZE_OPTIONS = ['25', '50', '100'];
// Fits the longest option of each select, so the toolbar does not jump.
const SELECT_WIDTH = 170;
const PAGE_SIZE_WIDTH = 80;

/** The typed value of the option a Select reports as a plain string. */
const chosen = <T extends string>(
  options: Option<T>[],
  value: string | null,
): T => (options.find((option) => option.value === value) ?? options[0]).value;

/** Status, Last active, Sort and search: each change starts at page 1. */
export function TableToolbar({
  query,
  onQuery,
  counts,
}: {
  query: UsersQuery;
  onQuery: (query: UsersQuery) => void;
  counts: StatusCounts | undefined;
}) {
  const firstPageWith = (change: Partial<UsersQuery>) =>
    onQuery({ ...query, ...change, page: FIRST_PAGE });
  return (
    <Group p="sm" align="end" gap="sm" wrap="wrap">
      <StatusChoice
        value={query.status}
        counts={counts}
        onChange={(status) => firstPageWith({ status })}
      />
      <Select
        label="Last active"
        value={query.active}
        onChange={(value) =>
          firstPageWith({ active: chosen(ACTIVE_OPTIONS, value) })
        }
        data={ACTIVE_OPTIONS}
        allowDeselect={false}
        w={SELECT_WIDTH}
        ml="auto"
      />
      <Select
        label="Sort"
        value={query.sort}
        onChange={(value) =>
          firstPageWith({ sort: chosen(SORT_OPTIONS, value) })
        }
        data={SORT_OPTIONS}
        allowDeselect={false}
        w={SELECT_WIDTH}
      />
      <TextInput
        label="Search user ID"
        value={query.search}
        maxLength={SEARCH_MAX_LENGTH}
        onChange={(event) =>
          firstPageWith({ search: event.currentTarget.value })
        }
      />
    </Group>
  );
}

/** A word, and after it the number of users when the analytics read has one. */
function counted(word: string, count: number | undefined): ReactNode {
  if (count === undefined) return word;
  return (
    <>
      {word}{' '}
      <Text span inherit fw={700}>
        {count}
      </Text>
    </>
  );
}

function StatusChoice({
  value,
  counts,
  onChange,
}: {
  value: UsersQuery['status'];
  counts: StatusCounts | undefined;
  onChange: (status: UsersQuery['status']) => void;
}) {
  const labelId = useId();
  const data = [
    { value: 'any' as const, label: counted('All', counts?.all) },
    ...STATUS_OPTIONS.map((option) => ({
      value: option.value,
      label: counted(option.label, counts?.byStatus[option.value]),
    })),
  ];
  return (
    <Stack gap={0}>
      <Text id={labelId} size="sm" fw={500}>
        Status
      </Text>
      <SegmentedControl<UsersQuery['status']>
        aria-labelledby={labelId}
        value={value}
        onChange={onChange}
        data={data}
      />
    </Stack>
  );
}

const pageSummary = (page: UsersPage) =>
  `Page ${page.page} of ${lastPage(page)} · ${page.total} matching users`;

/** Users per page, the two page buttons, and what the last read found. */
export function PageFooter({
  query,
  page,
  onQuery,
}: {
  query: UsersQuery;
  page: UsersPage | null;
  onQuery: (query: UsersQuery) => void;
}) {
  // Until the page answers, its last page is unknown: only going back works.
  const last = page ? lastPage(page) : query.page;
  const goTo = (pageNumber: number) => onQuery({ ...query, page: pageNumber });
  return (
    <Group justify="space-between" px="md" py="xs" gap="sm">
      <Group gap="md">
        {page && <Text size="sm">{pageSummary(page)}</Text>}
        {page && (
          <Text size="sm" c="dimmed">
            Updated {utcTime(page.completedAt)}
          </Text>
        )}
      </Group>
      <Group gap="xs">
        <PageSizeSelect query={query} onQuery={onQuery} />
        <ActionIcon
          variant="default"
          aria-label="Previous page"
          title="Previous page"
          disabled={query.page === FIRST_PAGE}
          onClick={() => goTo(query.page - 1)}
        >
          ‹
        </ActionIcon>
        <ActionIcon
          variant="default"
          aria-label="Next page"
          title="Next page"
          disabled={query.page >= last}
          onClick={() => goTo(query.page + 1)}
        >
          ›
        </ActionIcon>
      </Group>
    </Group>
  );
}

function PageSizeSelect({
  query,
  onQuery,
}: {
  query: UsersQuery;
  onQuery: (query: UsersQuery) => void;
}) {
  const pageSizeId = useId();
  return (
    <>
      <Text component="label" htmlFor={pageSizeId} size="sm">
        Users per page
      </Text>
      <Select
        id={pageSizeId}
        size="xs"
        w={PAGE_SIZE_WIDTH}
        value={String(query.pageSize)}
        onChange={(value) =>
          onQuery({ ...query, pageSize: Number(value), page: FIRST_PAGE })
        }
        data={PAGE_SIZE_OPTIONS}
        allowDeselect={false}
      />
    </>
  );
}
