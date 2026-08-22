"use strict";
/**
 * Covers args.ts: the CLI's own small flag parser. No tests existed for the
 * CLI at all before this file.
 */
const path = require("path");
const assert = require("assert");

const DIST = path.resolve(__dirname, "..", "dist");
const { parseArgs, flag, boolFlag } = require(path.join(DIST, "args.js"));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("positionals are collected in order", () => {
  const { positionals } = parseArgs(["build.apk", "--token", "abc", "extra"]);
  assert.deepStrictEqual(positionals, ["build.apk", "extra"]);
});

test("a flag followed by a value consumes it", () => {
  const { flags } = parseArgs(["--token", "abc123"]);
  assert.strictEqual(flags.token, "abc123");
});

test("a flag followed by another flag is a boolean switch", () => {
  const { flags } = parseArgs(["--json", "--no-qr"]);
  assert.strictEqual(flags.json, true);
  assert.strictEqual(flags["no-qr"], true);
});

test("a flag at the end of argv is a boolean switch", () => {
  const { flags } = parseArgs(["upload", "app.apk", "--json"]);
  assert.strictEqual(flags.json, true);
});

test("--name=value uses the inline value, even if it's empty", () => {
  const { flags } = parseArgs(["--notes=hello world", "--tag="]);
  assert.strictEqual(flags.notes, "hello world");
  assert.strictEqual(flags.tag, "");
});

test("a short flag (-t) parses the same way as a long one", () => {
  const { flags } = parseArgs(["-t", "abc"]);
  assert.strictEqual(flags.t, "abc");
});

test("-- ends flag parsing so a dash-prefixed filename still works", () => {
  const { positionals, flags } = parseArgs(["upload", "--", "--weird-name.apk", "--not-a-flag"]);
  assert.deepStrictEqual(positionals, ["upload", "--weird-name.apk", "--not-a-flag"]);
  assert.deepStrictEqual(flags, {});
});

test("flag() checks every accepted spelling in order", () => {
  const args = parseArgs(["--release-notes", "hi"]);
  assert.strictEqual(flag(args, ["notes", "n", "release-notes"]), "hi");
});

test("flag() returns the fallback when nothing matches", () => {
  const args = parseArgs([]);
  assert.strictEqual(flag(args, ["notes"], "default"), "default");
  assert.strictEqual(flag(args, ["notes"]), undefined);
});

test("flag() treats a valueless flag as an empty string, not the fallback", () => {
  const args = parseArgs(["--notes"]);
  assert.strictEqual(flag(args, ["notes"], "default"), "");
});

test("boolFlag() accepts the literal string \"true\" as well as a bare switch", () => {
  assert.strictEqual(boolFlag(parseArgs(["--json"]), ["json"]), true);
  assert.strictEqual(boolFlag(parseArgs(["--json=true"]), ["json"]), true);
  assert.strictEqual(boolFlag(parseArgs(["--json=false"]), ["json"]), false);
  assert.strictEqual(boolFlag(parseArgs([]), ["json"]), false);
});

test("a real upload invocation parses end to end", () => {
  const args = parseArgs([
    "app-release.apk",
    "--notes",
    "Fixes the crash on launch",
    "--tag=nightly",
    "--json",
  ]);
  assert.deepStrictEqual(args.positionals, ["app-release.apk"]);
  assert.strictEqual(flag(args, ["notes", "n"]), "Fixes the crash on launch");
  assert.strictEqual(flag(args, ["tag"]), "nightly");
  assert.strictEqual(boolFlag(args, ["json"]), true);
});

(async () => {
  let failed = 0;
  console.log("\nCLI argument parsing\n");
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${name}\n      ${err.message}`);
    }
  }
  console.log(failed ? `\n${failed} failing, ${tests.length - failed} passing\n` : `\n${tests.length} passing\n`);
  process.exit(failed ? 1 : 0);
})();
