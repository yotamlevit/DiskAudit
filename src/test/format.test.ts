import { describe, expect, test } from "vitest";
import { afterEach } from "vitest";
import { formatBytes, formatDuration, formatNumber, setByteUnits } from "../format";

// Units are a module-level setting; every test leaves it at the default.
afterEach(() => setByteUnits("macos"));

describe("formatBytes (decimal units, matching Finder)", () => {
  test("bytes below 1000 stay in B", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(999)).toBe("999 B");
  });

  test("KB starts at 1000, not 1024", () => {
    expect(formatBytes(1000)).toBe("1.00 KB");
    expect(formatBytes(1024)).toBe("1.02 KB");
  });

  test("decimal steps all the way up", () => {
    expect(formatBytes(1_000_000)).toBe("1.00 MB");
    expect(formatBytes(1_500_000_000)).toBe("1.50 GB");
    expect(formatBytes(2_000_000_000_000)).toBe("2.00 TB");
  });

  test("precision drops as the number grows", () => {
    expect(formatBytes(12_340_000)).toBe("12.3 MB");
    expect(formatBytes(123_400_000)).toBe("123 MB");
  });

  test("garbage in, zero out", () => {
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(NaN)).toBe("0 B");
    expect(formatBytes(Infinity)).toBe("0 B");
  });
});

describe("formatBytes follows the host's convention", () => {
  test("Windows: 1024-based under the same labels, as File Explorer shows", () => {
    setByteUnits("windows");
    expect(formatBytes(1000)).toBe("1000 B");
    expect(formatBytes(1024)).toBe("1.00 KB");
    expect(formatBytes(1_073_741_824)).toBe("1.00 GB");
    expect(formatBytes(100_000_000_000)).toBe("93.1 GB");
  });

  test("Linux and macOS stay decimal", () => {
    setByteUnits("linux");
    expect(formatBytes(100_000_000_000)).toBe("100 GB");
    setByteUnits("macos");
    expect(formatBytes(100_000_000_000)).toBe("100 GB");
  });

  test("rounding never prints a four-digit value in the smaller unit", () => {
    expect(formatBytes(999_999)).toBe("1.00 MB");
    setByteUnits("windows");
    expect(formatBytes(1024 * 1024 - 1)).toBe("1.00 MB");
  });
});

describe("formatDuration", () => {
  test("ms, seconds, minutes", () => {
    expect(formatDuration(400)).toBe("400 ms");
    expect(formatDuration(2340)).toBe("2.34 s");
    expect(formatDuration(75_000)).toBe("1m 15s");
  });
});

describe("formatNumber", () => {
  test("grouped", () => {
    expect(formatNumber(1234567)).toBe((1234567).toLocaleString());
  });
});
