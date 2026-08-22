"use strict";
/**
 * Covers config.ts: where `appdropper login` stores its credential, and the
 * precedence order resolveToken uses (--token > $APPDROPPER_TOKEN > saved
 * login). Uses a real temp directory via APPDROPPER_CONFIG_DIR rather than
 * mocking fs, since the file permissions (0600) are part of the contract.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const DIST = path.resolve(__dirname, "..", "dist");

let tmpDir;

function freshConfig() {
  delete require.cache[require.resolve(path.join(DIST, "config.js"))];
  return require(path.join(DIST, "config.js"));
}

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "appdropper-cli-test-"));
  process.env.APPDROPPER_CONFIG_DIR = tmpDir;
  delete process.env.APPDROPPER_TOKEN;
  delete process.env.APPDROPPER_API_URL;
  return freshConfig();
}

function teardown() {
  delete process.env.APPDROPPER_CONFIG_DIR;
  delete process.env.APPDROPPER_TOKEN;
  delete process.env.APPDROPPER_API_URL;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("apiUrl defaults to production and strips a trailing slash from an override", () => {
  const cfg = setup();
  try {
    assert.strictEqual(cfg.apiUrl(), cfg.DEFAULT_API_URL);
    process.env.APPDROPPER_API_URL = "https://staging.appdropper.io/api/v1/";
    assert.strictEqual(cfg.apiUrl(), "https://staging.appdropper.io/api/v1");
  } finally {
    teardown();
  }
});

test("loadCredential returns null before anything is saved", () => {
  const cfg = setup();
  try {
    assert.strictEqual(cfg.loadCredential("https://api.test"), null);
  } finally {
    teardown();
  }
});

test("saveCredential round-trips through loadCredential", () => {
  const cfg = setup();
  try {
    const credential = {
      token: "adp_x_y",
      app_ids: ["p1"],
      app_names: ["Checkout"],
      hint: "adp_x_••••y",
      expires_at: Date.now() + 90 * 86400_000,
    };
    cfg.saveCredential("https://api.test", credential);
    assert.deepStrictEqual(cfg.loadCredential("https://api.test"), credential);
  } finally {
    teardown();
  }
});

test("the config file and directory are written with private permissions", () => {
  const cfg = setup();
  try {
    cfg.saveCredential("https://api.test", {
      token: "adp_x_y",
      app_ids: [],
      app_names: [],
      hint: "h",
      expires_at: 0,
    });
    const fileMode = fs.statSync(cfg.configPath()).mode & 0o777;
    const dirMode = fs.statSync(cfg.configDir()).mode & 0o777;
    assert.strictEqual(fileMode, 0o600);
    assert.strictEqual(dirMode, 0o700);
  } finally {
    teardown();
  }
});

test("credentials are keyed per API base, so staging and prod don't collide", () => {
  const cfg = setup();
  try {
    cfg.saveCredential("https://prod.test", { token: "prod-token", app_ids: [], app_names: [], hint: "", expires_at: 0 });
    cfg.saveCredential("https://staging.test", { token: "staging-token", app_ids: [], app_names: [], hint: "", expires_at: 0 });
    assert.strictEqual(cfg.loadCredential("https://prod.test").token, "prod-token");
    assert.strictEqual(cfg.loadCredential("https://staging.test").token, "staging-token");
  } finally {
    teardown();
  }
});

test("saving a second credential for the same base doesn't disturb others", () => {
  const cfg = setup();
  try {
    cfg.saveCredential("https://a.test", { token: "a1", app_ids: [], app_names: [], hint: "", expires_at: 0 });
    cfg.saveCredential("https://b.test", { token: "b1", app_ids: [], app_names: [], hint: "", expires_at: 0 });
    cfg.saveCredential("https://a.test", { token: "a2", app_ids: [], app_names: [], hint: "", expires_at: 0 });
    assert.strictEqual(cfg.loadCredential("https://a.test").token, "a2");
    assert.strictEqual(cfg.loadCredential("https://b.test").token, "b1");
  } finally {
    teardown();
  }
});

test("clearCredential removes just the one base and reports whether it existed", () => {
  const cfg = setup();
  try {
    cfg.saveCredential("https://a.test", { token: "a1", app_ids: [], app_names: [], hint: "", expires_at: 0 });
    assert.strictEqual(cfg.clearCredential("https://ghost.test"), false);
    assert.strictEqual(cfg.clearCredential("https://a.test"), true);
    assert.strictEqual(cfg.loadCredential("https://a.test"), null);
  } finally {
    teardown();
  }
});

test("a corrupt config file is treated as no saved login, not a crash", () => {
  const cfg = setup();
  try {
    fs.mkdirSync(cfg.configDir(), { recursive: true });
    fs.writeFileSync(cfg.configPath(), "{not valid json");
    assert.strictEqual(cfg.loadCredential("https://a.test"), null);
    // And saving afterward must still work — the file gets overwritten cleanly.
    cfg.saveCredential("https://a.test", { token: "fresh", app_ids: [], app_names: [], hint: "", expires_at: 0 });
    assert.strictEqual(cfg.loadCredential("https://a.test").token, "fresh");
  } finally {
    teardown();
  }
});

test("resolveToken prefers an explicit token over everything else", () => {
  const cfg = setup();
  try {
    process.env.APPDROPPER_TOKEN = "env-token";
    cfg.saveCredential("https://a.test", { token: "saved-token", app_ids: [], app_names: [], hint: "", expires_at: 0 });
    assert.strictEqual(cfg.resolveToken("https://a.test", "explicit-token"), "explicit-token");
  } finally {
    teardown();
  }
});

test("resolveToken prefers the environment over a saved login", () => {
  const cfg = setup();
  try {
    process.env.APPDROPPER_TOKEN = "env-token";
    cfg.saveCredential("https://a.test", { token: "saved-token", app_ids: [], app_names: [], hint: "", expires_at: 0 });
    assert.strictEqual(cfg.resolveToken("https://a.test"), "env-token");
  } finally {
    teardown();
  }
});

test("resolveToken falls back to the saved login last", () => {
  const cfg = setup();
  try {
    cfg.saveCredential("https://a.test", { token: "saved-token", app_ids: [], app_names: [], hint: "", expires_at: 0 });
    assert.strictEqual(cfg.resolveToken("https://a.test"), "saved-token");
  } finally {
    teardown();
  }
});

test("resolveToken returns null when nothing is configured", () => {
  const cfg = setup();
  try {
    assert.strictEqual(cfg.resolveToken("https://a.test"), null);
  } finally {
    teardown();
  }
});

(async () => {
  let failed = 0;
  console.log("\nCredential storage and token resolution\n");
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
