export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;

// UTC, because the windows are UTC clock hours: every admin reads the same
// reset time, whatever their time zone.
export const utcTime = (iso: string): string => `${iso.slice(11, 19)} UTC`;
