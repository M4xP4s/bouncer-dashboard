import { expect, it } from 'vitest';
import type { RequestRecord } from '@app/contracts';
import { requestUpdate } from '../fixtures/index.ts';
import { latestRequests } from './latestRequests.ts';

it('deduplicates with the last copy winning and sorts newest time then plain ID', () => {
  const base: RequestRecord = {
    id: 'base',
    at: requestUpdate.at,
    outcome: 'allowed',
    remaining: 1,
  };
  const earlier = { ...base, id: 'earlier', at: '2026-11-16T10:00:00.000Z' };
  // Plain order is by character code: 'A' < '_' < 'a'. A locale would differ.
  const lowerA = { ...base, id: 'a' };
  const underscore = { ...base, id: '_' };
  const upperA = { ...base, id: 'A' };
  const replacement = { ...base, id: 'A', remaining: 0 };
  const input = [earlier, lowerA, underscore, upperA, replacement];

  const result = latestRequests(input);

  expect(result.map((record) => record.id)).toEqual(['A', '_', 'a', 'earlier']);
  expect(result[0]).toBe(replacement);
  expect(input).toEqual([earlier, lowerA, underscore, upperA, replacement]);
});

it('caps after deduplication and ordering', () => {
  const records = Array.from({ length: 102 }, (_, index): RequestRecord => ({
    // Zero-padded, so the IDs sort as text in numeric order.
    id: String(index).padStart(3, '0'),
    at: requestUpdate.at,
    outcome: 'denied',
    remaining: 0,
  }));

  const result = latestRequests([...records, records[0]]);

  expect(result).toHaveLength(100);
  expect(result[0].id).toBe('000');
  expect(result[99].id).toBe('099');
});
