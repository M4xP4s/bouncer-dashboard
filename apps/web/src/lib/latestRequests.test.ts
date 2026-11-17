import { expect, it } from 'vitest';
import { requestUpdate } from '../fixtures/index.ts';
import { latestRequests } from './latestRequests.ts';

it('deduplicates with the last copy winning and sorts newest time then plain ID', () => {
  const base = {
    id: 'base',
    at: requestUpdate.at,
    outcome: 'allowed' as const,
    remaining: 1,
  };
  const earlier = { ...base, id: 'earlier', at: '2026-11-16T10:00:00.000Z' };
  const replacement = { ...base, id: 'A', remaining: 0 };
  const input = [
    earlier,
    { ...base, id: 'a' },
    { ...base, id: '_' },
    { ...base, id: 'A' },
    replacement,
  ];
  const result = latestRequests(input);
  expect(result.map((record) => record.id)).toEqual(['A', '_', 'a', 'earlier']);
  expect(result[0]).toBe(replacement);
  expect(input).toHaveLength(5);
});

it('caps after deduplication and ordering', () => {
  const records = Array.from({ length: 102 }, (_, index) => ({
    id: String(index).padStart(3, '0'),
    at: requestUpdate.at,
    outcome: 'denied' as const,
    remaining: 0,
  }));
  const result = latestRequests([...records, records[0]]);
  expect(result).toHaveLength(100);
  expect(result[0].id).toBe('000');
  expect(result[99].id).toBe('099');
});
