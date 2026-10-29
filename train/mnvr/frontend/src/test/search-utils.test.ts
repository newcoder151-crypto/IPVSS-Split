import { describe, it, expect } from "vitest";
import { toApiDateTime, paginationRange } from "@/lib/utils";

describe("toApiDateTime", () => {
  it("produces a naive local string with no UTC/Z suffix", () => {
    const d = new Date(2026, 7, 19, 0, 0, 0, 0); // 19 Aug 2026, local midnight
    const out = toApiDateTime(d);
    expect(out).toBe("2026-08-19T00:00:00.000");
    expect(out).not.toMatch(/Z$/);
    expect(out).not.toMatch(/[+-]\d\d:\d\d$/);
  });

  it("does NOT shift the calendar day the way .toISOString() can", () => {
    // Regression guard for the exact "Today shows 0 recordings" bug:
    // .toISOString() converts to UTC and can push local midnight onto the
    // previous UTC calendar day depending on the browser's timezone.
    // toApiDateTime must never do that — the digits it produces must
    // match the local wall-clock date/time exactly, since that's what the
    // recording pipeline stores.
    const localMidnight = new Date(2026, 7, 19, 0, 0, 0, 0);
    const out = toApiDateTime(localMidnight);
    expect(out.slice(0, 10)).toBe("2026-08-19");
  });

  it("round-trips hours/minutes/seconds exactly", () => {
    const d = new Date(2026, 0, 5, 14, 7, 33, 250);
    expect(toApiDateTime(d)).toBe("2026-01-05T14:07:33.250");
  });
});

describe("paginationRange", () => {
  it("computes totalPages/rangeFrom/rangeTo for a full first page", () => {
    expect(paginationRange(1, 25, 130)).toEqual({
      totalPages: 6,
      rangeFrom: 1,
      rangeTo: 25,
    });
  });

  it("computes a partial last page correctly", () => {
    expect(paginationRange(6, 25, 130)).toEqual({
      totalPages: 6,
      rangeFrom: 126,
      rangeTo: 130,
    });
  });

  it("handles zero results without dividing by zero or going negative", () => {
    expect(paginationRange(1, 25, 0)).toEqual({
      totalPages: 1,
      rangeFrom: 0,
      rangeTo: 0,
    });
  });

  it("handles a single page smaller than pageSize", () => {
    expect(paginationRange(1, 25, 8)).toEqual({
      totalPages: 1,
      rangeFrom: 1,
      rangeTo: 8,
    });
  });

  it("never returns rangeTo greater than total", () => {
    expect(paginationRange(2, 10, 15)).toEqual({
      totalPages: 2,
      rangeFrom: 11,
      rangeTo: 15,
    });
  });
});
