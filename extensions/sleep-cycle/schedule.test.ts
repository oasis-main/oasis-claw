import { describe, expect, it } from "vitest";
import {
  dateKeyInTimeZone,
  isAtOrPast,
  isWithinWindow,
  minutesInTimeZone,
  parseHHMM,
} from "./src/schedule.js";

describe("parseHHMM", () => {
  it("parses valid 24h times", () => {
    expect(parseHHMM("00:00")).toBe(0);
    expect(parseHHMM("06:30")).toBe(390);
    expect(parseHHMM("22:00")).toBe(1320);
    expect(parseHHMM("23:59")).toBe(1439);
  });

  it("rejects invalid input", () => {
    expect(parseHHMM(undefined)).toBeNull();
    expect(parseHHMM("")).toBeNull();
    expect(parseHHMM("24:00")).toBeNull();
    expect(parseHHMM("7:00")).toBeNull();
    expect(parseHHMM("22:60")).toBeNull();
    expect(parseHHMM("bogus")).toBeNull();
  });
});

describe("minutesInTimeZone", () => {
  it("resolves UTC minutes", () => {
    // 2026-01-15T13:45:00Z
    const ms = Date.UTC(2026, 0, 15, 13, 45);
    expect(minutesInTimeZone(ms, "UTC")).toBe(13 * 60 + 45);
  });

  it("resolves offset zones (EST = UTC-5 in January)", () => {
    const ms = Date.UTC(2026, 0, 15, 13, 45);
    expect(minutesInTimeZone(ms, "America/New_York")).toBe(8 * 60 + 45);
  });

  it("returns null on a bad timezone", () => {
    expect(minutesInTimeZone(Date.UTC(2026, 0, 15), "Not/AZone")).toBeNull();
  });
});

describe("isAtOrPast", () => {
  const noonUtc = Date.UTC(2026, 0, 15, 12, 0);
  it("true at/after the target", () => {
    expect(isAtOrPast("12:00", "UTC", noonUtc)).toBe(true);
    expect(isAtOrPast("11:59", "UTC", noonUtc)).toBe(true);
  });
  it("false before the target", () => {
    expect(isAtOrPast("12:01", "UTC", noonUtc)).toBe(false);
  });
  it("fails open to false on bad input", () => {
    expect(isAtOrPast("24:00", "UTC", noonUtc)).toBe(false);
  });
});

describe("isWithinWindow (night window crossing midnight)", () => {
  it("22:00 -> 06:30 window", () => {
    const at = (h: number, m: number) => Date.UTC(2026, 0, 15, h, m);
    expect(isWithinWindow("22:00", "06:30", "UTC", at(23, 0))).toBe(true);
    expect(isWithinWindow("22:00", "06:30", "UTC", at(3, 0))).toBe(true);
    expect(isWithinWindow("22:00", "06:30", "UTC", at(6, 29))).toBe(true);
    expect(isWithinWindow("22:00", "06:30", "UTC", at(6, 30))).toBe(false);
    expect(isWithinWindow("22:00", "06:30", "UTC", at(12, 0))).toBe(false);
  });
});

describe("dateKeyInTimeZone", () => {
  it("rolls the date at local midnight, not UTC midnight", () => {
    // 2026-01-16T02:00:00Z is still Jan 15 in New York (UTC-5).
    const ms = Date.UTC(2026, 0, 16, 2, 0);
    expect(dateKeyInTimeZone(ms, "America/New_York")).toBe("2026-01-15");
    expect(dateKeyInTimeZone(ms, "UTC")).toBe("2026-01-16");
  });
});
