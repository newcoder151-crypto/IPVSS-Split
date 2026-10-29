import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { format } from "date-fns";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Formats a Date as a *local, timezone-naive* "YYYY-MM-DDTHH:mm:ss.SSS"
// string for the recordings/events search APIs. Deliberately NOT
// `.toISOString()`: that always converts to UTC, but the recording
// pipeline (stream_manager.py) writes start_timestamp using the server's
// local wall clock (from the ffmpeg segment filename) into a timezone-naive
// TIMESTAMP column - Postgres then ignores any "Z"/offset on the
// comparison value entirely (per the timestamp-without-time-zone spec) and
// compares raw digits. Sending a UTC-shifted string was being compared
// against local-time-stored data, offset by the server's UTC delta - the
// root cause of "Today" search reporting 0 recordings that clearly exist.
// This keeps both sides of the comparison in the same (local, naive) time.
export function toApiDateTime(date: Date): string {
  return format(date, "yyyy-MM-dd'T'HH:mm:ss.SSS");
}

export interface PaginationRange {
  totalPages: number;
  rangeFrom: number;
  rangeTo: number;
}

// Pure page-math for a 1-indexed pager: "Showing rangeFrom-rangeTo of
// total" plus totalPages, given the current page/pageSize/total. Pulled
// out of SearchPage so it has direct test coverage rather than only being
// exercised indirectly through the component.
export function paginationRange(page: number, pageSize: number, total: number): PaginationRange {
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const rangeFrom = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeTo = Math.min(page * pageSize, total);
  return { totalPages, rangeFrom, rangeTo };
}
