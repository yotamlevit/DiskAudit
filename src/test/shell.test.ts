// @vitest-environment node
import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deleteCommand,
  deletionScript,
  exportCsv,
  exportJson,
  exportPlain,
  shellQuote,
  validateSelection,
  ReclaimExportItem,
} from "../shell";

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

// ----- Findings export -----------------------------------------------------

const META = {
  root: "/Users/me",
  generatedAt: "2026-07-25T10:00:00.000Z",
  appVersion: "1.1.0",
  home: "/Users/me",
};

function item(p: string, size = 1000, over?: Partial<ReclaimExportItem>): ReclaimExportItem {
  return {
    path: p,
    size,
    isDir: true,
    category: "build_artifact",
    confidence: "safe",
    reason: "Recreate with npm install",
    ...over,
  };
}

describe("exports", () => {
  test("plain: header comments + one path per line", () => {
    const txt = exportPlain([item("/Users/me/a"), item("/Users/me/b")], META);
    const lines = txt.trim().split("\n");
    expect(lines[0]).toMatch(/^# DiskAudit/);
    expect(txt).toContain("# Scan root: /Users/me");
    expect(txt).toContain("by DiskAudit 1.1.0");
    expect(lines.slice(-2)).toEqual(["/Users/me/a", "/Users/me/b"]);
  });

  test("csv: provenance header, then rows with hard fields quoted", () => {
    const nasty = item('/Users/me/we,ird "dir"\nname', 2500);
    const txt = exportCsv([nasty], META);
    expect(txt).toContain("# Scan root: /Users/me");
    expect(txt).toContain("# Items: 1  Total: 2500 bytes");
    expect(txt).toContain(
      "path,bytes,size,kind,category,confidence,reason"
    );
    // CSV-quoted: internal quotes doubled, whole field wrapped.
    expect(txt).toContain('"/Users/me/we,ird ""dir""\nname",2500');
  });

  test("json: parseable, with provenance and items", () => {
    const txt = exportJson([item("/Users/me/a", 42)], META);
    const parsed = JSON.parse(txt);
    expect(parsed.tool).toBe("DiskAudit");
    expect(parsed.scan_root).toBe("/Users/me");
    expect(parsed.total_bytes).toBe(42);
    expect(parsed.items[0]).toMatchObject({
      path: "/Users/me/a",
      bytes: 42,
      category: "build_artifact",
    });
  });
});

// ----- Validator -----------------------------------------------------------

describe("validateSelection", () => {
  const check = (p: string) =>
    validateSelection([item(p)], "/Users/me", "/Users/me");

  test("rejects the dangerous classics", () => {
    for (const p of [
      "/",
      "/Users/me", // $HOME (and the scan root)
      "/Users/me/Library",
      "/Users/me/Documents",
      "/System",
      "/Users",
    ]) {
      const r = check(p);
      expect(r.ok, p).toHaveLength(0);
      expect(r.rejected, p).toHaveLength(1);
    }
  });

  test("rejects empty, whitespace, relative and traversal paths", () => {
    for (const p of ["", "   ", "relative/path", "/Users/me/../me2/x"]) {
      const r = check(p);
      expect(r.ok, JSON.stringify(p)).toHaveLength(0);
    }
  });

  test("rejects anything outside the scan root", () => {
    const r = validateSelection(
      [item("/Users/other/node_modules")],
      "/Users/me",
      "/Users/me"
    );
    expect(r.ok).toHaveLength(0);
    expect(r.rejected[0].reason).toMatch(/outside/);
  });

  test("prefix look-alikes are not 'within' the root", () => {
    const r = validateSelection(
      [item("/Users/me-evil/x")],
      "/Users/me",
      "/Users/me"
    );
    expect(r.ok).toHaveLength(0);
  });

  test("drops the ANCESTOR when selected paths nest", () => {
    const r = validateSelection(
      [item("/Users/me/proj"), item("/Users/me/proj/node_modules")],
      "/Users/me",
      "/Users/me"
    );
    expect(r.ok.map((i) => i.path)).toEqual(["/Users/me/proj/node_modules"]);
    expect(r.rejected[0].item.path).toBe("/Users/me/proj");
    expect(r.rejected[0].reason).toMatch(/contains another/);
  });

  test("trash mode refuses items already in the Trash", () => {
    const r = validateSelection(
      [item("/Users/me/.Trash/old")],
      "/Users/me",
      "/Users/me",
      "trash"
    );
    expect(r.ok).toHaveLength(0);
    expect(r.rejected[0].reason).toMatch(/already in the Trash/);
    // …but the permanent script may include them.
    const rm = validateSelection(
      [item("/Users/me/.Trash/old")],
      "/Users/me",
      "/Users/me",
      "rm"
    );
    expect(rm.ok).toHaveLength(1);
  });

  test("valid findings pass", () => {
    const r = validateSelection(
      [item("/Users/me/code/app/node_modules"), item("/Users/me/.Trash")],
      "/Users/me",
      "/Users/me"
    );
    expect(r.ok).toHaveLength(2);
    expect(r.rejected).toHaveLength(0);
  });
});

// ----- Script text ---------------------------------------------------------

describe("deletionScript text", () => {
  const items = [
    item("/Users/me/code/app/node_modules", 12_000_000_000),
    item("/Users/me/it's a dir", 5_000, { category: "app_cache" }),
  ];

  test("trash mode: shebang, strict flags, dry-run guard, quoting", () => {
    const { script, included, rejected } = deletionScript(items, META, "trash");
    expect(rejected).toHaveLength(0);
    expect(included).toHaveLength(2);
    expect(script.startsWith("#!/bin/bash\n")).toBe(true);
    expect(script).toContain("set -euo pipefail");
    // Dry-run is the default; --yes is the only way to apply.
    expect(script).toContain(`APPLY=0`);
    expect(script).toContain(`if [ "\${1:-}" = "--yes" ]; then APPLY=1; fi`);
    expect(script).toContain("DRY RUN");
    // Paths are single-quoted through shellQuote.
    expect(script).toContain(`process '/Users/me/code/app/node_modules'`);
    expect(script).toContain(`process '/Users/me/it'\\''s a dir'`);
    // Trash destination, existence re-check, no rm in trash mode's actions.
    expect(script).toContain(`$HOME/.Trash/`);
    expect(script).toContain(`if [ ! -e "$p" ] && [ ! -L "$p" ]; then`);
    expect(script).not.toMatch(/\brm -rf\b/);
    // Per-item review comments with size and why.
    expect(script).toContain("12.0 GB");
    expect(script).toContain("Recreate with npm install");
    // Provenance header.
    expect(script).toContain("Scan root: /Users/me");
    expect(script).toContain("by DiskAudit 1.1.0");
  });

  test("rm mode is explicit and clearly labeled", () => {
    const { script } = deletionScript(items, META, "rm");
    expect(script).toContain("PERMANENT");
    expect(script).toContain("NO undo");
    expect(script).toContain(`rm -rf -- "$p"`);
    expect(script).not.toContain(".Trash/");
  });

  test("unsafe entries are dropped and listed, not emitted", () => {
    const { script, included, rejected } = deletionScript(
      [item("/Users/me/ok-dir"), item("/Users/me"), item("/etc")],
      META,
      "trash"
    );
    expect(included.map((i) => i.path)).toEqual(["/Users/me/ok-dir"]);
    expect(rejected).toHaveLength(2);
    expect(script).toContain("NOT INCLUDED");
    // The rejected paths appear only in comments, never as commands.
    for (const line of script.split("\n")) {
      if (line.startsWith("process ")) {
        expect(line).toBe(`process '/Users/me/ok-dir'`);
      }
    }
  });

  test("newlines never break out of the review comments", () => {
    const evil = item("/Users/me/x\nrm -rf sentinel", 1000);
    const { script } = deletionScript([evil], META, "trash");
    // Comments are sanitized (newline → space)…
    expect(script).toContain("# --- 1. x rm -rf sentinel");
    // …while the process line keeps the exact path inside single quotes.
    expect(script).toContain(`process '/Users/me/x\nrm -rf sentinel'`);
    // (That quoting is proven safe by execution in the behavior suite.)
  });

  test("empty selection still produces a valid no-op script", () => {
    const { script, included } = deletionScript([], META, "trash");
    expect(included).toHaveLength(0);
    expect(script).toContain("#!/bin/bash");
  });
});

// ----- The generated script actually behaves as promised -------------------
//
// These tests execute a GENERATED script with bash against a throwaway
// fixture under the OS tmpdir (and a fake $HOME for trash mode). This is
// the test suite running bash on a tmp fixture — the app itself still has
// no code path that executes scripts, which no-exec-path asserts below.

function makeFixture(): {
  root: string;
  fakeHome: string;
  bigDir: string;
  file: string;
} {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "diskaudit-script-"));
  const root = path.join(base, "scanroot");
  const fakeHome = path.join(base, "fakehome");
  const bigDir = path.join(root, "proj", "node_modules");
  fs.mkdirSync(bigDir, { recursive: true });
  fs.mkdirSync(path.join(fakeHome, ".Trash"), { recursive: true });
  fs.writeFileSync(path.join(bigDir, "blob.bin"), Buffer.alloc(200_000, 7));
  const file = path.join(root, "old installer's.dmg");
  fs.writeFileSync(file, Buffer.alloc(50_000, 1));
  return { root, fakeHome, bigDir, file };
}

function runScript(
  script: string,
  fakeHome: string,
  args: string[] = [],
  cwd?: string
): string {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "da-run-")), "s.sh");
  fs.writeFileSync(f, script); // test harness writes it, as a USER would
  return execFileSync("/bin/bash", [f, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: fakeHome },
    cwd,
  });
}

describe("generated script behavior (executed by the test harness, not the app)", () => {
  test("dry run touches nothing; --yes trashes exactly the listed items", () => {
    const { root, fakeHome, bigDir, file } = makeFixture();
    const meta = {
      root,
      generatedAt: new Date().toISOString(),
      appVersion: "1.1.0",
      home: fakeHome,
    };
    const { script } = deletionScript(
      [item(bigDir, 200_000), item(file, 50_000, { isDir: false })],
      meta,
      "trash"
    );

    const dry = runScript(script, fakeHome);
    expect(dry).toContain("DRY RUN");
    expect(fs.existsSync(bigDir)).toBe(true);
    expect(fs.existsSync(file)).toBe(true);

    const applied = runScript(script, fakeHome, ["--yes"]);
    expect(fs.existsSync(bigDir)).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
    const trashed = fs.readdirSync(path.join(fakeHome, ".Trash")).sort();
    expect(trashed).toEqual(["node_modules", "old installer's.dmg"]);
    expect(applied).toMatch(/Done: 2 moved to Trash, 0 skipped, 0 failed/);
    // The measured running total is real bytes, not zero.
    const m = applied.match(/Measured total: (\d+) bytes/);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeGreaterThan(0);
  });

  test("a vanished path is reported and skipped; the rest still proceeds", () => {
    const { root, fakeHome, bigDir, file } = makeFixture();
    const meta = {
      root,
      generatedAt: new Date().toISOString(),
      appVersion: "1.1.0",
      home: fakeHome,
    };
    const { script } = deletionScript(
      [item(bigDir, 200_000), item(file, 50_000, { isDir: false })],
      meta,
      "rm"
    );
    fs.rmSync(bigDir, { recursive: true }); // vanish before the user runs it
    const out = runScript(script, fakeHome, ["--yes"]);
    expect(out).toContain("SKIP (no longer exists)");
    expect(fs.existsSync(file)).toBe(false);
    expect(out).toMatch(/Done: 1 deleted, 1 skipped, 0 failed/);
  });

  test("a newline-injected name is trashed as data, never run as a command", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "diskaudit-inject-"));
    const root = path.join(base, "scanroot");
    const fakeHome = path.join(base, "fakehome");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(path.join(fakeHome, ".Trash"), { recursive: true });
    const sentinel = path.join(root, "sentinel.txt");
    fs.writeFileSync(sentinel, "must survive");
    // A directory whose NAME tries to smuggle in a command (relative, so it
    // would resolve against the cwd we deliberately run the script from).
    const evil = path.join(root, "x\nrm -rf sentinel.txt");
    fs.mkdirSync(evil);
    const meta = {
      root,
      generatedAt: new Date().toISOString(),
      appVersion: "1.1.0",
      home: fakeHome,
    };
    const { script } = deletionScript([item(evil, 100)], meta, "trash");
    runScript(script, fakeHome, ["--yes"], root);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("must survive");
    expect(fs.existsSync(evil)).toBe(false);
  });

  test("same-basename items don't clobber each other in the Trash", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "diskaudit-clash-"));
    const root = path.join(base, "scanroot");
    const fakeHome = path.join(base, "fakehome");
    fs.mkdirSync(path.join(root, "a", "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(root, "b", "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(fakeHome, ".Trash"), { recursive: true });
    fs.writeFileSync(path.join(root, "a", "node_modules", "x"), "a-content");
    fs.writeFileSync(path.join(root, "b", "node_modules", "y"), "b-content");
    const meta = {
      root,
      generatedAt: new Date().toISOString(),
      appVersion: "1.1.0",
      home: fakeHome,
    };
    const { script } = deletionScript(
      [
        item(path.join(root, "a", "node_modules"), 100),
        item(path.join(root, "b", "node_modules"), 100),
      ],
      meta,
      "trash"
    );
    runScript(script, fakeHome, ["--yes"]);
    const trashed = fs.readdirSync(path.join(fakeHome, ".Trash"));
    expect(trashed.length).toBe(2);
    // Both contents survived, under distinct names.
    const contents = trashed
      .flatMap((d) => fs.readdirSync(path.join(fakeHome, ".Trash", d)))
      .sort();
    expect(contents).toEqual(["x", "y"]);
  });
});

// ----- The app has no execution path ---------------------------------------

describe("no-exec-path", () => {
  test("no app source imports child_process or executes commands", () => {
    const srcDir = path.join(__dirname, "..");
    const offenders: string[] = [];
    const visit = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "test") continue; // the test harness may exec
          visit(p);
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
          const text = fs.readFileSync(p, "utf8");
          if (/child_process|execFile|execSync|spawn\(/.test(text)) {
            offenders.push(p);
          }
        }
      }
    };
    visit(srcDir);
    expect(offenders).toEqual([]);
  });
});
