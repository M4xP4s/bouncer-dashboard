import {
  counterExpiry,
  keys,
  minuteInWindow,
  resetAt,
  retryAfterSeconds,
  utcDay,
  windowExpiry,
  windowStart,
} from './keys.js';

const at = (iso: string) => Date.parse(iso);

describe('window times', () => {
  it.each([
    // One millisecond before a boundary still belongs to the old hour.
    ['2026-11-16T10:59:59.999Z', '10:00:00.000Z', '11:00:00.000Z', 1],
    // The boundary itself opens the new hour.
    ['2026-11-16T11:00:00.000Z', '11:00:00.000Z', '12:00:00.000Z', 3600],
    ['2026-11-16T11:00:00.001Z', '11:00:00.000Z', '12:00:00.000Z', 3600],
  ])('%s', (now, start, reset, retry) => {
    expect(windowStart(at(now))).toBe(at(`2026-11-16T${start}`));
    expect(resetAt(at(now))).toBe(at(`2026-11-16T${reset}`));
    expect(retryAfterSeconds(at(now))).toBe(retry);
  });

  it('keeps a window key for one hour after the window ends', () => {
    // A process whose clock is slightly behind must not find the key gone.
    expect(windowExpiry(at('2026-11-16T10:42:00.000Z'))).toBe(
      at('2026-11-16T12:00:00.000Z'),
    );
  });

  it('keeps counters 25 hours from the window start', () => {
    expect(counterExpiry(at('2026-11-16T10:42:00.000Z'))).toBe(
      at('2026-11-17T11:00:00.000Z'),
    );
  });

  it('changes the day at UTC midnight', () => {
    expect(utcDay(at('2026-11-16T23:59:59.999Z'))).toBe('2026-11-16');
    expect(utcDay(at('2026-11-17T00:00:00.000Z'))).toBe('2026-11-17');
  });

  it.each([
    ['2026-11-16T10:00:00.000Z', 0],
    ['2026-11-16T10:59:59.999Z', 59],
  ])('counts the minute from the window start at %s', (time, minute) => {
    expect(minuteInWindow(at(time))).toBe(minute);
  });
});

describe('key names', () => {
  const now = at('2026-11-16T10:42:00.000Z');
  const hour = at('2026-11-16T10:00:00.000Z');

  // The only case with an ID that has uppercase letters and an underscore:
  // a key that normalizes the ID fails here and nowhere else without Redis.
  it('names the history, counter, daily and alert-flag keys', () => {
    expect(keys.history('User_03-A')).toBe('rl:hist:User_03-A');
    expect(keys.stat('User_03-A', now)).toBe(`rl:stat:User_03-A:${hour}`);
    expect(keys.denied(now)).toBe('rl:denied:2026-11-16');
    expect(keys.notified('User_03-A', now, 7)).toBe(
      `rl:notified:User_03-A:${hour}:7`,
    );
  });

  it('starts a new window key at the hour boundary', () => {
    const nextHour = at('2026-11-16T11:00:00.000Z');

    const lastKey = keys.window('user-01', at('2026-11-16T10:59:59.999Z'));
    const nextKey = keys.window('user-01', nextHour);

    expect(lastKey).toBe(`rl:win:user-01:${hour}`);
    expect(nextKey).toBe(`rl:win:user-01:${nextHour}`);
  });
});
