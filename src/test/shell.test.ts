// @vitest-environment node
import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { deleteCommand, shellQuote } from "../shell";

/** The real test: does the quoted path survive an actual shell round trip? */
function roundTrip(path: string): string {
  return execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote(path)}`], {
    encoding: "utf8",
  });
}

const NASTY_PATHS = [
  "/Users/me/simple",
  "/Users/me/with spaces/file.txt",
  "/Users/me/it's got 'quotes'",
  '/Users/me/double "quotes" here',
  "/Users/me/$HOME `backticks` $(cmd)",
  "/Users/me/semi;colon && ampersand | pipe",
  "/Users/me/glob*?[chars]",
  "/Users/me/unicode — dashes и кириллица 日本語 🗂",
  "/Users/me/newline\nin name",
  "/Users/me/back\\slash",
  "/Users/me/-starts-with-dash",
];

describe("shellQuote", () => {
  for (const p of NASTY_PATHS) {
    test(`round-trips intact: ${JSON.stringify(p).slice(0, 50)}`, () => {
      expect(roundTrip(p)).toBe(p);
    });
  }

  test("never interpolates: $ and backticks stay literal", () => {
    const q = shellQuote("/tmp/$USER/`whoami`");
    expect(roundTrip("/tmp/$USER/`whoami`")).toBe("/tmp/$USER/`whoami`");
    expect(q).not.toContain('"');
  });
});

describe("deleteCommand", () => {
  test("folders get rm -rf, files get rm -f", () => {
    expect(deleteCommand("/Users/me/big-folder", true)).toBe(
      "rm -rf '/Users/me/big-folder'"
    );
    expect(deleteCommand("/Users/me/big file.mov", false)).toBe(
      "rm -f '/Users/me/big file.mov'"
    );
  });

  test("quotes survive inside the command", () => {
    expect(deleteCommand("/Users/me/it's", true)).toBe(
      "rm -rf '/Users/me/it'\\''s'"
    );
  });
});
