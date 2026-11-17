// Guards the search box and the Status and Last active selects: each control
// must narrow the rows that are actually on screen. A select wired to the
// wrong state, a wrong option value, or filter arguments passed in the wrong
// order would leave the pure `filterUsers` tests green and the table wrong.
import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { NOW, users } from '../../fixtures/index.ts';
import { UsersTable } from './UsersTable.tsx';

function shownUserIds() {
  return screen.queryAllByRole('button').map((button) => button.textContent);
}

function renderTable() {
  render(
    <MantineProvider>
      <UsersTable
        rows={new Map(users.map((row) => [row.userId, row]))}
        snapshot={{ status: 'loaded', error: null }}
        now={Date.parse(NOW)}
        onSelect={vi.fn()}
      />
    </MantineProvider>,
  );
}

it('Search user ID leaves only the IDs that contain the text', () => {
  renderTable();
  fireEvent.change(screen.getByLabelText('Search user ID'), {
    target: { value: 'user-1' },
  });
  expect(shownUserIds()).toEqual(['user-10', 'user-11', 'user-12']);
});

it.each([
  ['Status', 'Exceeded', ['user-06', 'user-09', 'user-11']],
  [
    'Last active',
    'Last 5 minutes',
    [
      'user-01',
      'user-02',
      'user-03',
      'user-04',
      'user-05',
      'user-06',
      'user-07',
      'user-08',
      'user-09',
    ],
  ],
] as const)(
  '%s "%s" leaves only the matching rows',
  (label, option, expected) => {
    renderTable();
    fireEvent.click(screen.getByRole('combobox', { name: label }));
    fireEvent.click(screen.getByRole('option', { name: option }));
    expect(shownUserIds()).toEqual(expected);
  },
);
