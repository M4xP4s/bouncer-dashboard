export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

// UTC, because the windows are UTC clock hours: every admin reads the same
// reset time, whatever their time zone.
export const utcTime = (iso: string): string => `${iso.slice(11, 19)} UTC`;

export const utcDateTime = (iso: string): string =>
  iso.replace('T', ' ').replace('Z', ' UTC');

/** Whole minutes until `iso`, rounded up; zero once it has passed. */
export const minutesUntil = (iso: string, now: number): number =>
  Math.max(0, Math.ceil((Date.parse(iso) - now) / MINUTE_MS));
