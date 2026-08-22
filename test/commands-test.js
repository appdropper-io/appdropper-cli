"use strict";
/**
 * Covers the remaining CLI commands: whoami, token rotate, builds list,
 * login, and logout — none of which had any coverage before this file.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const assert = require("assert");

const DIST = path.resolve(__dirname, "..", "dist");
const { parseArgs } = require(path.join(DIST, "args.js"));
const { whoamiCommand, rotateCommand } = require(path.join(DIST, "commands/account.js"));
const { buildsCommand } = require(path.join(DIST, "commands/builds.js"));
const { loginCommand, logoutCommand } = require(path.join(DIST, "commands/login.js"));
const { loadCredential, saveCredential } = require(path.join(DIST, "config.js"));
const { EXIT, CliError } = require(path.join(DIST, "errors.js"));

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

let workDir;
function setup() {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "appdropper-cli-cmd-test-"));
  process.env.APPDROPPER_CONFIG_DIR = path.join(workDir, "config");
  delete process.env.APPDROPPER_TOKEN;
}
function teardown() {
  delete process.env.APPDROPPER_CONFIG_DIR;
  delete process.env.APPDROPPER_TOKEN;
  delete process.env.APPDROPPER_API_URL;
  fs.rmSync(workDir, { recursive: true, force: true });
}

async function capture(fn) {
  const outs = [];
  const errs = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c) => {
    outs.push(c);
    return true;
  };
  process.stderr.write = (c) => {
    errs.push(c);
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  return { stdout: outs.join(""), stderr: errs.join("") };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ------------------------------------------------------------------- whoami

test("whoamiCommand requires a token", async () => {
  setup();
  try {
    await assert.rejects(
      () => whoamiCommand(parseArgs([])),
      (err) => err instanceof CliError && err.exitCode === EXIT.AUTH
    );
  } finally {
    teardown();
  }
});

test("whoamiCommand --json prints the identity payload verbatim", async () => {
  setup();
  const server = await startServer((req, res) => {
    sendJson(res, 200, {
      token_name: "CI token",
      hint: "adp_x_••••y",
      scopes: ["upload:builds"],
      expires_at: null,
      apps: [{ app_id: "p1", app_name: "Checkout", bundle_id: "com.acme.checkout", install_url: "u" }],
    });
  });
  process.env.APPDROPPER_API_URL = server.baseUrl;
  process.env.APPDROPPER_TOKEN = "adp_x";
  try {
    const { stdout } = await capture(() => whoamiCommand(parseArgs(["--json"])));
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.token_name, "CI token");
  } finally {
    await server.close();
    teardown();
  }
});

test("whoamiCommand warns when the token covers zero apps", async () => {
  setup();
  const server = await startServer((req, res) => {
    sendJson(res, 200, { token_name: "x", hint: "h", scopes: [], expires_at: null, apps: [] });
  });
  process.env.APPDROPPER_API_URL = server.baseUrl;
  process.env.APPDROPPER_TOKEN = "adp_x";
  try {
    const { stderr } = await capture(() => whoamiCommand(parseArgs([])));
    assert.match(stderr, /doesn't cover any app/);
  } finally {
    await server.close();
    teardown();
  }
});

// -------------------------------------------------------------- token rotate

test("rotateCommand updates the saved credential in place when it's the one rotated", async () => {
  setup();
  const server = await startServer((req, res) => {
    sendJson(res, 200, { token: "adp_new", token_id: "tok2", hint: "adp_new_••••", expires_at: 999 });
  });
  process.env.APPDROPPER_API_URL = server.baseUrl;
  saveCredential(server.baseUrl, {
    token: "adp_old",
    app_ids: ["p1"],
    app_names: ["Checkout"],
    hint: "adp_old_••••",
    expires_at: 1,
  });
  try {
    await capture(() => rotateCommand(parseArgs(["--token", "adp_old"])));
    const saved = loadCredential(server.baseUrl);
    assert.strictEqual(saved.token, "adp_new");
    assert.strictEqual(saved.app_names[0], "Checkout", "app list is preserved, only the token itself changes");
  } finally {
    await server.close();
    teardown();
  }
});

test("rotateCommand prints the new token to stdout when it isn't the saved login", async () => {
  setup();
  const server = await startServer((req, res) => {
    sendJson(res, 200, { token: "adp_new", token_id: "tok2", hint: "adp_new_••••", expires_at: 999 });
  });
  process.env.APPDROPPER_API_URL = server.baseUrl;
  process.env.APPDROPPER_TOKEN = "adp_ci_token";
  try {
    const { stdout } = await capture(() => rotateCommand(parseArgs([])));
    assert.strictEqual(stdout.trim(), "adp_new");
  } finally {
    await server.close();
    teardown();
  }
});

// ------------------------------------------------------------------ builds

test("buildsCommand rejects an unknown subcommand", async () => {
  setup();
  try {
    await assert.rejects(
      () => buildsCommand(parseArgs(["delete"])),
      (err) => err instanceof CliError && err.exitCode === EXIT.USAGE && /Unknown builds command/.test(err.message)
    );
  } finally {
    teardown();
  }
});

test("buildsCommand list defaults to 'self' and clamps the limit to 100", async () => {
  setup();
  let seenUrl;
  const server = await startServer((req, res) => {
    seenUrl = req.url;
    sendJson(res, 200, { app_name: "Checkout", bundle_id: "com.acme.checkout", builds: [] });
  });
  process.env.APPDROPPER_API_URL = server.baseUrl;
  process.env.APPDROPPER_TOKEN = "adp_x";
  try {
    await capture(() => buildsCommand(parseArgs(["list", "--limit", "500"])));
    assert.ok(seenUrl.includes("/apps/self/builds?limit=100"));
  } finally {
    await server.close();
    teardown();
  }
});

test("buildsCommand list prints each build's version, platform, and status", async () => {
  setup();
  const server = await startServer((req, res) => {
    sendJson(res, 200, {
      app_name: "Checkout",
      bundle_id: "com.acme.checkout",
      builds: [
        {
          build_id: "b1",
          version: "1.0.0",
          build_number: "1",
          platform: "android",
          tag: "beta",
          file_size: 1024,
          status: "ready",
          install_count: 3,
          uploaded_at: Date.now(),
          expires_at: Date.now() + 86400_000,
          files_purged: false,
          install_url: "https://appdropper.io/d/checkout",
        },
      ],
    });
  });
  process.env.APPDROPPER_API_URL = server.baseUrl;
  process.env.APPDROPPER_TOKEN = "adp_x";
  try {
    const { stderr } = await capture(() => buildsCommand(parseArgs(["list"])));
    assert.match(stderr, /1\.0\.0/);
    assert.match(stderr, /android/);
    assert.match(stderr, /3 installs/);
  } finally {
    await server.close();
    teardown();
  }
});

// -------------------------------------------------------------- login/logout

test("logoutCommand reports nothing to do when there's no saved login", async () => {
  setup();
  try {
    const { stderr } = await capture(() => logoutCommand());
    assert.match(stderr, /No saved login/);
  } finally {
    teardown();
  }
});

test("logoutCommand clears a saved credential", async () => {
  setup();
  process.env.APPDROPPER_API_URL = "https://api.test";
  saveCredential("https://api.test", { token: "t", app_ids: [], app_names: ["Checkout"], hint: "", expires_at: 0 });
  try {
    await capture(() => logoutCommand());
    assert.strictEqual(loadCredential("https://api.test"), null);
  } finally {
    teardown();
  }
});

test("loginCommand gives up once the device code's deadline passes", async () => {
  setup();
  const server = await startServer(async (req, res) => {
    if (req.url === "/device/code") {
      return sendJson(res, 200, {
        device_code: "dc1",
        user_code: "ABCD-2345",
        verification_uri: "https://appdropper.io/device",
        verification_uri_complete: "https://appdropper.io/device?code=ABCD-2345",
        expires_in: 0,
        interval: 0,
      });
    }
    if (req.url === "/device/token") {
      await readBody(req);
      // Always pending: the code never gets approved, so the only way out of
      // the poll loop is the expiry check.
      return sendJson(res, 400, { error: { code: "authorization_pending", message: "x" } });
    }
    sendJson(res, 404, { error: {} });
  });
  process.env.APPDROPPER_API_URL = server.baseUrl;
  try {
    await assert.rejects(
      () => capture(() => loginCommand(parseArgs(["--no-browser"]))),
      (err) => err instanceof CliError && err.exitCode === EXIT.AUTH && /expired/.test(err.message)
    );
  } finally {
    await server.close();
    teardown();
  }
});

test("loginCommand polls until granted, then saves the credential", async () => {
  setup();
  let pollCount = 0;
  const server = await startServer(async (req, res) => {
    if (req.url === "/device/code") {
      return sendJson(res, 200, {
        device_code: "dc1",
        user_code: "ABCD-2345",
        verification_uri: "https://appdropper.io/device",
        verification_uri_complete: "https://appdropper.io/device?code=ABCD-2345",
        expires_in: 60,
        interval: 0,
      });
    }
    if (req.url === "/device/token") {
      pollCount++;
      await readBody(req);
      if (pollCount < 2) {
        return sendJson(res, 400, { error: { code: "authorization_pending", message: "x" } });
      }
      return sendJson(res, 200, {
        access_token: "adp_granted",
        token_id: "tok1",
        hint: "adp_x_••••",
        app_ids: ["p1"],
        app_names: ["Checkout"],
        expires_at: Date.now() + 90 * 86400_000,
      });
    }
    sendJson(res, 404, { error: {} });
  });
  process.env.APPDROPPER_API_URL = server.baseUrl;
  try {
    const { stderr } = await capture(() => loginCommand(parseArgs(["--no-browser"])));
    assert.match(stderr, /Signed in/);
    const saved = loadCredential(server.baseUrl);
    assert.strictEqual(saved.token, "adp_granted");
    assert.deepStrictEqual(saved.app_names, ["Checkout"]);
    assert.ok(pollCount >= 2);
  } finally {
    await server.close();
    teardown();
  }
});

(async () => {
  let failed = 0;
  console.log("\nwhoami, token rotate, builds, login/logout\n");
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${name}\n      ${err.stack ?? err.message}`);
    }
  }
  console.log(failed ? `\n${failed} failing, ${tests.length - failed} passing\n` : `\n${tests.length} passing\n`);
  process.exit(failed ? 1 : 0);
})();
