"use strict";
/**
 * Covers uploadCommand end to end: argument/file validation, the full
 * reserve → send → await-processing flow against a fake local server, JSON
 * output mode, server-side failures, and the GITHUB_OUTPUT integration.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const assert = require("assert");

const DIST = path.resolve(__dirname, "..", "dist");
const { parseArgs } = require(path.join(DIST, "args.js"));
const { uploadCommand } = require(path.join(DIST, "commands/upload.js"));
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

/** A minimal but real App Dropper API + GCS double for one upload. */
async function happyServer(overrides = {}) {
  let uploadedBody = Buffer.alloc(0);
  const server = await startServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/uploads") {
      await readBody(req);
      return sendJson(res, 200, {
        upload_id: "u1",
        upload_url: `${server.baseUrl}/gcs/u1`,
        content_type: "application/vnd.android.package-archive",
        app_id: "p1",
        app_name: "Checkout",
      });
    }
    if (req.method === "PUT" && req.url === "/gcs/u1") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        uploadedBody = Buffer.concat(chunks);
        res.writeHead(200);
        res.end();
      });
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/uploads/u1")) {
      return sendJson(res, 200, {
        upload_id: "u1",
        status: overrides.status ?? "ready",
        app_name: "Checkout",
        version: "1.0.0",
        build_number: "1",
        install_url: `${server.baseUrl}/d/checkout`,
        qr_url: `${server.baseUrl}/qr/u1`,
        build_id: "b1",
        error: overrides.error,
      });
    }
    sendJson(res, 404, { error: { code: "not_found", message: "?" } });
  });
  return { ...server, uploadedBody: () => uploadedBody };
}

let workDir;
function setup() {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "appdropper-cli-upload-test-"));
  process.env.APPDROPPER_CONFIG_DIR = path.join(workDir, "config"); // always empty: no saved login
  delete process.env.APPDROPPER_TOKEN;
  delete process.env.GITHUB_OUTPUT;
}
function teardown() {
  delete process.env.APPDROPPER_CONFIG_DIR;
  delete process.env.APPDROPPER_TOKEN;
  delete process.env.APPDROPPER_API_URL;
  delete process.env.GITHUB_OUTPUT;
  fs.rmSync(workDir, { recursive: true, force: true });
}

function makeFile(name, content = Buffer.alloc(1000, 1)) {
  const p = path.join(workDir, name);
  fs.writeFileSync(p, content);
  return p;
}

/** Captures everything written to stdout while `fn` runs. */
async function captureStdout(fn) {
  const original = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = (chunk) => {
    out += chunk;
    return true;
  };
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true; // silence progress/info noise during tests
  try {
    await fn();
  } finally {
    process.stdout.write = original;
    process.stderr.write = originalErr;
  }
  return out;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("rejects with no file argument", async () => {
  setup();
  try {
    await assert.rejects(
      () => uploadCommand(parseArgs([])),
      (err) => err instanceof CliError && err.exitCode === EXIT.USAGE && /Which file/.test(err.message)
    );
  } finally {
    teardown();
  }
});

test("rejects a file that doesn't exist", async () => {
  setup();
  process.env.APPDROPPER_TOKEN = "adp_x";
  try {
    await assert.rejects(
      () => uploadCommand(parseArgs([path.join(workDir, "ghost.apk")])),
      (err) => err instanceof CliError && err.exitCode === EXIT.USAGE && /No such file/.test(err.message)
    );
  } finally {
    teardown();
  }
});

test("rejects a wrong extension before touching the network", async () => {
  setup();
  process.env.APPDROPPER_TOKEN = "adp_x";
  const file = makeFile("notes.txt");
  try {
    await assert.rejects(
      () => uploadCommand(parseArgs([file])),
      (err) => err instanceof CliError && err.exitCode === EXIT.USAGE && /\.apk and \.ipa/.test(err.message)
    );
  } finally {
    teardown();
  }
});

test("rejects with no token configured anywhere", async () => {
  setup();
  const file = makeFile("app.apk");
  try {
    await assert.rejects(
      () => uploadCommand(parseArgs([file])),
      (err) => err instanceof CliError && err.exitCode === EXIT.AUTH
    );
  } finally {
    teardown();
  }
});

test("uploads the exact file bytes and prints the install link on stdout", async () => {
  setup();
  const server = await happyServer();
  process.env.APPDROPPER_API_URL = server.baseUrl;
  process.env.APPDROPPER_TOKEN = "adp_x";
  const content = Buffer.alloc(20_000, 3);
  const file = makeFile("app.apk", content);
  try {
    const stdout = await captureStdout(() => uploadCommand(parseArgs([file])));
    assert.ok(server.uploadedBody().equals(content), "the exact file bytes must reach storage");
    assert.match(stdout, new RegExp(`${server.baseUrl}/d/checkout`));
  } finally {
    await server.close();
    teardown();
  }
});

test("--json prints the full status object instead of a human summary", async () => {
  setup();
  const server = await happyServer();
  process.env.APPDROPPER_API_URL = server.baseUrl;
  process.env.APPDROPPER_TOKEN = "adp_x";
  const file = makeFile("app.apk");
  try {
    const stdout = await captureStdout(() => uploadCommand(parseArgs([file, "--json"])));
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.status, "ready");
    assert.strictEqual(parsed.app_name, "Checkout");
  } finally {
    await server.close();
    teardown();
  }
});

test("a build the server couldn't parse fails with the server's own message", async () => {
  setup();
  const server = await happyServer({
    status: "error",
    error: { code: "bad_binary", message: "We couldn't read this APK." },
  });
  process.env.APPDROPPER_API_URL = server.baseUrl;
  process.env.APPDROPPER_TOKEN = "adp_x";
  const file = makeFile("app.apk");
  try {
    await assert.rejects(
      () => captureStdout(() => uploadCommand(parseArgs([file]))),
      (err) => err instanceof CliError && err.exitCode === EXIT.FAILURE && /couldn't read this APK/.test(err.message)
    );
  } finally {
    await server.close();
    teardown();
  }
});

test("a 401 from the reservation step maps to the AUTH exit code", async () => {
  setup();
  const server = await startServer((req, res) => {
    sendJson(res, 401, { error: { code: "token_revoked", message: "This token was revoked." } });
  });
  process.env.APPDROPPER_API_URL = server.baseUrl;
  process.env.APPDROPPER_TOKEN = "adp_dead";
  const file = makeFile("app.apk");
  try {
    await assert.rejects(
      () => captureStdout(() => uploadCommand(parseArgs([file]))),
      (err) => err instanceof CliError && err.exitCode === EXIT.AUTH
    );
  } finally {
    await server.close();
    teardown();
  }
});

test("a 429 from the reservation step maps to the RATE_LIMITED exit code", async () => {
  setup();
  const server = await startServer((req, res) => {
    sendJson(res, 429, { error: { code: "rate_limited", message: "Try again in 5 min." } });
  });
  process.env.APPDROPPER_API_URL = server.baseUrl;
  process.env.APPDROPPER_TOKEN = "adp_x";
  const file = makeFile("app.apk");
  try {
    await assert.rejects(
      () => captureStdout(() => uploadCommand(parseArgs([file]))),
      (err) => err instanceof CliError && err.exitCode === EXIT.RATE_LIMITED
    );
  } finally {
    await server.close();
    teardown();
  }
});

test("writes GitHub Actions step outputs when GITHUB_OUTPUT is set", async () => {
  setup();
  const server = await happyServer();
  process.env.APPDROPPER_API_URL = server.baseUrl;
  process.env.APPDROPPER_TOKEN = "adp_x";
  const outputFile = path.join(workDir, "gh-output");
  fs.writeFileSync(outputFile, "");
  process.env.GITHUB_OUTPUT = outputFile;
  const file = makeFile("app.apk");
  try {
    await captureStdout(() => uploadCommand(parseArgs([file])));
    const written = fs.readFileSync(outputFile, "utf8");
    assert.match(written, /install-url=.+\/d\/checkout/);
    assert.match(written, /build-id=b1/);
    assert.match(written, /qr-url=.+\/qr\/u1/);
  } finally {
    await server.close();
    teardown();
  }
});

test("a --token flag beats a token saved on disk", async () => {
  setup();
  let seenAuth = null;
  const server = await startServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/uploads") {
      seenAuth = req.headers.authorization;
      await readBody(req);
      return sendJson(res, 200, {
        upload_id: "u1",
        upload_url: `${server.baseUrl}/gcs/u1`,
        content_type: "application/octet-stream",
        app_id: "p1",
        app_name: "Checkout",
      });
    }
    if (req.method === "PUT" && req.url === "/gcs/u1") {
      req.resume();
      req.on("end", () => {
        res.writeHead(200);
        res.end();
      });
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/uploads/u1")) {
      return sendJson(res, 200, { upload_id: "u1", status: "ready", install_url: "https://x/d/y" });
    }
    sendJson(res, 404, { error: {} });
  });
  process.env.APPDROPPER_API_URL = server.baseUrl;
  const { saveCredential } = require(path.join(DIST, "config.js"));
  saveCredential(server.baseUrl, { token: "adp_saved", app_ids: [], app_names: [], hint: "", expires_at: 0 });
  const file = makeFile("app.apk");
  try {
    await captureStdout(() => uploadCommand(parseArgs([file, "--token", "adp_explicit"])));
    assert.strictEqual(seenAuth, "Bearer adp_explicit");
  } finally {
    await server.close();
    teardown();
  }
});

(async () => {
  let failed = 0;
  console.log("\nuploadCommand end to end\n");
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
