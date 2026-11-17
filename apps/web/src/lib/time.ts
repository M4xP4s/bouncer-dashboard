/**
 * The time of day of an ISO 8601 UTC timestamp, as `HH:MM:SS UTC`.
 *
 * Shown in UTC because the windows are UTC clock hours: the reset time is
 * then the same text for every admin, whatever their time zone.
 */
export const utcTime = (iso: string): string => `${iso.slice(11, 19)} UTC`;
