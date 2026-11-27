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
  psLiteral,
  psQuote,
  scriptText,
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

// The bash dialect is executed with /bin/sh and /bin/bash, which a Windows
// test machine does not have at those paths.
const POSIX_HOST = process.platform !== "win32";

describe.skipIf(!POSIX_HOST)("shellQuote", () => {
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

describe.skipIf(!POSIX_HOST)("generated script behavior (executed by the test harness, not the app)", () => {
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

// ----- Windows / PowerShell -------------------------------------------------

/** PowerShell 7 runs on every OS, so the PowerShell dialect is executed for
 * real wherever `pwsh` is installed (all GitHub-hosted runners have it).
 * Without it these behavioural tests are skipped — the text-level tests
 * below them still run. */
const PWSH = (() => {
  try {
    execFileSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const W = String.raw;

describe("psQuote", () => {
  test("doubles straight AND typographic single quotes", () => {
    expect(psQuote(W`C:\a b\it's`)).toBe(W`'C:\a b\it''s'`);
    // PowerShell treats U+2018/2019/201A/201B as string delimiters too.
    expect(psQuote("C:\\x\u2019y")).toBe("'C:\\x\u2019\u2019y'");
    expect(psQuote("C:\\x\u2018\u201A\u201By")).toBe(
      "'C:\\x\u2018\u2018\u201A\u201A\u201B\u201By'"
    );
  });

  test("leaves everything else alone — nothing expands in single quotes", () => {
    const p = W`C:\$env:USERPROFILE` + "\\`whoami` $(Remove-Item x) ; & | \"q\"";
    expect(psQuote(p)).toBe(`'${p}'`);
  });

  const NASTY = [
    "simple",
    "with spaces",
    "it's got 'quotes'",
    "curly \u2018quotes\u2019 and \u201Alow\u201B ones",
    'double "quotes"',
    "$env:HOME `backtick` $(Get-Date) @(1) #hash",
    "semi; & amp | pipe > redirect",
    "unicode — и кириллица 日本語 🗂",
  ];
  for (const name of NASTY) {
    test.skipIf(!PWSH)(`round-trips through PowerShell: ${JSON.stringify(name).slice(0, 40)}`, () => {
      const out = execFileSync(
        "pwsh",
        ["-NoProfile", "-Command", `[Console]::Out.Write(${psLiteral(name)})`],
        { encoding: "utf8" }
      );
      expect(out).toBe(name);
    });
  }
});

describe("psLiteral (what actually reaches a script)", () => {
  test("pure ASCII is just the quoted string", () => {
    expect(psLiteral(W`C:\Users\me\it's`)).toBe(W`'C:\Users\me\it''s'`);
    expect(psLiteral("")).toBe("''");
  });

  test("anything else is spelled as code units, never as raw bytes", () => {
    expect(psLiteral("C:\\caf\u00e9\\x")).toBe("('C:\\caf' + [char]0x00E9 + '\\x')");
    // Starts with a string so `+` concatenates from the first term.
    expect(psLiteral("\u00e9a")).toBe("('' + [char]0x00E9 + 'a')");
    // Astral characters are two code units; control characters are escaped.
    expect(psLiteral("a\u{1F5C2}")).toBe("('a' + [char]0xD83D + [char]0xDDC2)");
    expect(psLiteral("a\nb")).toBe("('a' + [char]0x000A + 'b')");
  });

  test("output is printable ASCII for any input", () => {
    // "Ò" is C3 92 in UTF-8; read as Windows-1252, 92 is a typographic quote
    // that PowerShell accepts as a string delimiter.
    for (const name of ["\u00d2'; calc; '", "\u2019", "日本語", "x\u0000y", "\r\n"]) {
      expect(psLiteral(name)).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});

describe("deleteCommand on Windows", () => {
  test("folders use the junction-safe .NET delete; files use -LiteralPath", () => {
    expect(deleteCommand(W`C:\Users\me\big folder`, true, "windows")).toBe(
      W`[System.IO.Directory]::Delete('C:\Users\me\big folder', $true)`
    );
    expect(deleteCommand(W`C:\Users\me\it's.iso`, false, "windows")).toBe(
      W`Remove-Item -LiteralPath 'C:\Users\me\it''s.iso' -Force`
    );
  });
});

describe("validateSelection on Windows", () => {
  const home = W`C:\Users\me`;
  const check = (p: string, root = home, mode?: "trash" | "rm", category?: string) =>
    validateSelection(
      [{ ...item(p), ...(category ? { category } : {}) }],
      root,
      home,
      mode,
      "windows"
    );

  test("rejects the dangerous classics, whatever their case", () => {
    for (const p of [
      "C:\\",
      W`C:\Users`,
      W`C:\Windows`,
      W`c:\windows`,
      W`C:\Program Files`,
      W`C:\ProgramData`,
      W`C:\Users\me`,
      W`C:\USERS\ME` + "\\",
      W`C:\Users\me\Documents`,
      W`C:\Users\me\AppData`,
      W`C:\Users\me\AppData\Local`,
      W`C:\Users\me\AppData\Local\Temp`,
    ]) {
      const r = check(p, "C:\\");
      expect(r.ok, p).toHaveLength(0);
      expect(r.rejected, p).toHaveLength(1);
    }
  });

  test("rejects relative, traversal, POSIX and impossible paths", () => {
    for (const p of [
      "",
      W`Users\me\x`,
      "/Users/me/x",
      W`C:\Users\me\..\other\x`,
      W`C:\Users\me\a"b`,
      W`C:\Users\me\a|b`,
      "C:\\Users\\me\\a\nb",
    ]) {
      expect(check(p).ok, JSON.stringify(p)).toHaveLength(0);
    }
  });

  test("containment is case-insensitive and segment-aware", () => {
    expect(check(W`c:\users\ME\code\app\node_modules`).ok).toHaveLength(1);
    expect(check(W`C:\Users\me-evil\x`).ok).toHaveLength(0);
    expect(check(W`D:\Users\me\code\node_modules`).ok).toHaveLength(0);
  });

  test("the Recycle Bin and system package caches are never scripted", () => {
    const drive = "C:\\";
    for (const mode of ["trash", "rm"] as const) {
      const r = check(W`C:\$Recycle.Bin\S-1-5-21\$R123`, drive, mode);
      expect(r.ok).toHaveLength(0);
      expect(r.rejected[0].reason).toMatch(/Recycle Bin/);
    }
    const upd = check(W`C:\Windows\SoftwareDistribution\Download`, drive, "rm", "package_cache");
    expect(upd.ok).toHaveLength(0);
    expect(upd.rejected[0].reason).toMatch(/Disk Cleanup/);
  });

  test("same path in two spellings is one entry; ancestors still drop", () => {
    const r = validateSelection(
      [
        item(W`C:\Users\me\proj\node_modules`),
        item(W`c:\users\me\PROJ\node_modules` + "\\"),
        item(W`C:\Users\me\proj`),
      ],
      home,
      home,
      "rm",
      "windows"
    );
    expect(r.ok.map((i) => i.path)).toEqual([W`C:\Users\me\proj\node_modules`]);
  });
});

describe("validateSelection on Linux", () => {
  const home = "/home/me";
  test("protects the XDG and system directories", () => {
    for (const p of ["/home/me/.cache", "/home/me/.local/share", "/home/me/.config", "/usr", "/var/cache"]) {
      expect(validateSelection([item(p)], "/", home, "rm", "linux").ok, p).toHaveLength(0);
    }
    expect(
      validateSelection([item("/home/me/.cache/mozilla")], home, home, "rm", "linux").ok
    ).toHaveLength(1);
  });

  test("trash mode refuses what is already in a trash folder", () => {
    for (const p of ["/home/me/.local/share/Trash/files/x", "/mnt/usb/.Trash-1000/files/x"]) {
      const r = validateSelection([item(p)], "/", home, "trash", "linux");
      expect(r.ok, p).toHaveLength(0);
    }
  });

  test("package-manager caches are refused with a pointer to the right tool", () => {
    const r = validateSelection(
      [{ ...item("/var/cache/apt/archives"), category: "package_cache" }],
      "/",
      home,
      "rm",
      "linux"
    );
    expect(r.rejected[0].reason).toMatch(/package manager/);
  });
});

describe("deletionScript dialects", () => {
  const winMeta = {
    root: W`C:\Users\me`,
    generatedAt: "2026-01-01T00:00:00.000Z",
    appVersion: "test",
    home: W`C:\Users\me`,
    os: "windows" as const,
  };

  test("Windows: PowerShell, dry-run guard, quoting, no Remove-Item -Recurse", () => {
    const { script, included } = deletionScript(
      [item(W`C:\Users\me\code\it's here\node_modules`)],
      winMeta,
      "trash"
    );
    expect(included).toHaveLength(1);
    expect(script).not.toContain("#!/bin/bash");
    expect(script).toContain("$Apply = ($args -contains '--yes')");
    expect(script).toContain("MOVE TO RECYCLE BIN");
    expect(script).toContain("SendToRecycleBin");
    // Never silently permanent: Windows must be allowed to ask.
    expect(script).toContain("UIOption]::AllDialogs");
    expect(script).toContain(W`Invoke-Entry 'C:\Users\me\code\it''s here\node_modules'`);
    expect(script).not.toMatch(/Remove-Item[^\n]*-Recurse/);
    expect(script.split("\r\n").length).toBeGreaterThan(40);
  });

  test("Windows permanent mode says so and walks trees itself", () => {
    const { script } = deletionScript(
      [item(W`C:\Users\me\code\app\node_modules`)],
      winMeta,
      "rm"
    );
    expect(script).toContain("PERMANENT DELETE");
    expect(script).toContain("function Remove-Tree");
    expect(script).toContain("ReparsePoint");
    expect(script).not.toContain("SendToRecycleBin");
  });

  test("Linux trash mode goes through gio and checks for it first", () => {
    const { script } = deletionScript(
      [item("/home/me/code/app/node_modules")],
      { root: "/home/me", generatedAt: "t", appVersion: "test", home: "/home/me", os: "linux" },
      "trash"
    );
    expect(script).toContain("#!/bin/bash");
    expect(script).toContain("command -v gio");
    expect(script).toContain('gio trash -- "$p"');
    expect(script).not.toContain(".Trash/");
  });

  test("no path is ever interpolated into PowerShell outside psQuote", () => {
    const evil = W`C:\Users\me\x'; Remove-Item C:\ -Recurse; '`;
    const { script } = deletionScript([item(evil)], winMeta, "rm");
    const callLines = script.split("\r\n").filter((l) => l.startsWith("Invoke-Entry "));
    expect(callLines).toEqual([`Invoke-Entry ${psLiteral(evil)}`]);
    // Every other occurrence of the name is inside a `#` comment.
    for (const line of script.split("\r\n")) {
      if (line.includes("Remove-Item C:") && !line.startsWith("Invoke-Entry ")) {
        expect(line.startsWith("#")).toBe(true);
      }
    }
  });
});

describe("PowerShell scripts are encoding-proof", () => {
  test("the whole script is printable ASCII, even with non-ASCII names", () => {
    const meta = {
      root: W`C:\Users\Zo` + "\u00eb",
      generatedAt: "2026-01-01T00:00:00.000Z",
      appVersion: "test",
      home: W`C:\Users\Zo` + "\u00eb",
      os: "windows" as const,
    };
    for (const mode of ["trash", "rm"] as const) {
      const { script, included, rejected } = deletionScript(
        [
          { ...item(meta.root + W`\code\caf` + "\u00e9 \u00d2\u2019 日本\\node_modules"), reason: "Recreate — with npm" },
          item(meta.root), // refused: listed in a comment
        ],
        meta,
        mode
      );
      expect(included).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(script).toMatch(/^[\x20-\x7e\r\n]+$/);
      expect(script).toContain("[char]0x00D2 + [char]0x2019");
    }
  });
});

describe.skipIf(!PWSH)("generated PowerShell behavior (run by the test harness, not the app)", () => {
  const run = (script: string, args: string[] = []) => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "da-ps-")), "s.ps1");
    fs.writeFileSync(f, script);
    return execFileSync("pwsh", ["-NoProfile", "-File", f, ...args], { encoding: "utf8" });
  };
  const meta = (root: string) => ({
    root,
    generatedAt: "t",
    appVersion: "test",
    home: "",
    os: "windows" as const,
  });
  const entry = (p: string, size = 1): ReclaimExportItem => ({ ...item(p), size });

  test("dry run touches nothing; --yes deletes exactly the listed items", () => {
    const fx = makeFixture();
    const keep = path.join(fx.root, "proj", "keep.txt");
    fs.writeFileSync(keep, "keep me");
    const script = scriptText([entry(fx.bigDir), entry(fx.file)], [], meta(fx.root), "rm");

    const dry = run(script);
    expect(dry).toContain("DRY RUN");
    expect(dry).toContain("would delete");
    expect(dry).toMatch(/2 items, 250000 bytes/);
    expect(fs.existsSync(fx.bigDir)).toBe(true);
    expect(fs.existsSync(fx.file)).toBe(true);

    const real = run(script, ["--yes"]);
    expect(real).toContain("Done: 2 deleted, 0 skipped, 0 failed.");
    expect(fs.existsSync(fx.bigDir)).toBe(false);
    expect(fs.existsSync(fx.file)).toBe(false);
    expect(fs.readFileSync(keep, "utf8")).toBe("keep me");
  });

  test("a link inside a deleted folder is removed as a link — its target survives", () => {
    const fx = makeFixture();
    const outside = path.join(fx.root, "precious");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "thesis.txt"), "irreplaceable");
    try {
      fs.symlinkSync(outside, path.join(fx.bigDir, "link-to-precious"), "junction");
    } catch {
      return; // no symlink privilege on this machine
    }
    const out = run(scriptText([entry(fx.bigDir)], [], meta(fx.root), "rm"), ["--yes"]);
    expect(out).toContain("Done: 1 deleted, 0 skipped, 0 failed.");
    expect(fs.existsSync(fx.bigDir)).toBe(false);
    expect(fs.readFileSync(path.join(outside, "thesis.txt"), "utf8")).toBe("irreplaceable");
  });

  test("read-only files do not stop the delete", () => {
    const fx = makeFixture();
    fs.chmodSync(path.join(fx.bigDir, "blob.bin"), 0o444);
    const out = run(scriptText([entry(fx.bigDir)], [], meta(fx.root), "rm"), ["--yes"]);
    expect(out).toContain("Done: 1 deleted, 0 skipped, 0 failed.");
    expect(fs.existsSync(fx.bigDir)).toBe(false);
  });

  test("a vanished path is reported and skipped; the rest still proceeds", () => {
    const fx = makeFixture();
    const gone = path.join(fx.root, "already-gone");
    const out = run(scriptText([entry(gone), entry(fx.file)], [], meta(fx.root), "rm"), ["--yes"]);
    expect(out).toContain("SKIP (no longer exists)");
    expect(out).toContain("Done: 1 deleted, 1 skipped, 0 failed.");
    expect(fs.existsSync(fx.file)).toBe(false);
  });

  test("a name full of PowerShell syntax is deleted as data, never run", () => {
    const fx = makeFixture();
    const canary = path.join(fx.root, "canary.txt");
    fs.writeFileSync(canary, "alive");
    const evilName = `x'; Remove-Item -LiteralPath '${canary}'; $(Remove-Item '${canary}') \u2019`;
    const evil = path.join(fx.root, "proj", evilName.replaceAll("/", "_").replaceAll("\\", "_"));
    try {
      fs.writeFileSync(evil, "data");
    } catch {
      return; // the host filesystem refuses this name (Windows)
    }
    const out = run(scriptText([entry(evil)], [], meta(fx.root), "rm"), ["--yes"]);
    expect(out).toContain("Done: 1 deleted, 0 skipped, 0 failed.");
    expect(fs.existsSync(evil)).toBe(false);
    expect(fs.readFileSync(canary, "utf8")).toBe("alive");
  });

  test("recycle mode previews without loading anything destructive", () => {
    const fx = makeFixture();
    const out = run(scriptText([entry(fx.file)], [], meta(fx.root), "trash"));
    expect(out).toContain("would recycle");
    expect(fs.existsSync(fx.file)).toBe(true);
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
