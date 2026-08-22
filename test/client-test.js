"use strict";
/**
 * Covers client.ts against a real local HTTP server standing in for both the
 * App Dropper API and the GCS resumable-upload session — no mocking of
 * node:http itself, so the actual request/response handling runs.
 *
 * The one thing this can't exercise is TLS, since the fake server is plain
 * HTTP; everything else (headers, JSON envelope, resumable retry math) is
 * the real code path.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const assert = require("assert");

const DIST = path.resolve(__dirname, "..", "dist");
const { AppDropperClient, ApiError, uploadFile, userAgent } = require(path.join(DIST, "client.js"));

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

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("userAgent() includes the package version and the running Node version", () => {
  const ua = userAgent();
  assert.match(ua, /^appdropper-cli\/\d+\.\d+\.\d+ node\/\d/);
});

test("a 4xx response is parsed into an ApiError with the server's code and message", async () => {
  const server = await startServer((req, res) => {
    sendJson(res, 401, { error: { code: "token_revoked", message: "This token was revoked." } });
  });
  try {
    const client = new AppDropperClient(server.baseUrl, "adp_bad");
    await assert.rejects(
      () => client.whoami(),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.strictEqual(err.status, 401);
        assert.strictEqual(err.code, "token_revoked");
        assert.strictEqual(err.message, "This token was revoked.");
        return true;
      }
    );
  } finally {
    await server.close();
  }
});

test("a 5xx with a non-JSON body still produces a usable ApiError", async () => {
  const server = await startServer((req, res) => {
    res.writeHead(502, { "content-type": "text/html" });
    res.end("<html>Bad Gateway</html>");
  });
  try {
    const client = new AppDropperClient(server.baseUrl, "adp_x");
    await assert.rejects(
      () => client.whoami(),
      (err) => err instanceof ApiError && err.status === 502 && err.code === "http_error"
    );
  } finally {
    await server.close();
  }
});

test("createUpload sends the right JSON body and Authorization header", async () => {
  let seenAuth, seenBody;
  const server = await startServer(async (req, res) => {
    seenAuth = req.headers.authorization;
    seenBody = JSON.parse(await readBody(req));
    sendJson(res, 200, {
      upload_id: "u1",
      upload_url: "http://127.0.0.1:1/gcs/u1",
      content_type: "application/vnd.android.package-archive",
      app_id: "p1",
      app_name: "Checkout",
    });
  });
  try {
    const client = new AppDropperClient(server.baseUrl, "adp_secret");
    const ticket = await client.createUpload({
      fileName: "app.apk",
      fileSize: 12345,
      releaseNotes: "Fixes login",
      tag: "nightly",
      ci: { provider: "GitHub Actions" },
    });
    assert.strictEqual(seenAuth, "Bearer adp_secret");
    assert.strictEqual(seenBody.file_name, "app.apk");
    assert.strictEqual(seenBody.file_size, 12345);
    assert.strictEqual(seenBody.release_notes, "Fixes login");
    assert.strictEqual(seenBody.tag, "nightly");
    assert.deepStrictEqual(seenBody.ci, { provider: "GitHub Actions" });
    assert.strictEqual(ticket.app_name, "Checkout");
  } finally {
    await server.close();
  }
});

test("whoami, listBuilds, and rotate parse their JSON payloads", async () => {
  let seenPath;
  const server = await startServer((req, res) => {
    seenPath = req.url;
    if (req.url.startsWith("/me")) return sendJson(res, 200, { token_name: "CI", hint: "adp_x_••••y", scopes: ["upload:builds"], expires_at: null, apps: [] });
    if (req.url.startsWith("/apps/")) return sendJson(res, 200, { app_name: "Checkout", bundle_id: "com.acme.checkout", builds: [] });
    if (req.url.startsWith("/tokens/rotate")) return sendJson(res, 200, { token: "adp_new", token_id: "tok2", hint: "adp_new_••••", expires_at: 123 });
    sendJson(res, 404, { error: { code: "not_found", message: "?" } });
  });
  try {
    const client = new AppDropperClient(server.baseUrl, "adp_x");
    const identity = await client.whoami();
    assert.strictEqual(identity.token_name, "CI");

    const builds = await client.listBuilds("self", 20);
    assert.strictEqual(builds.app_name, "Checkout");

    await client.listBuilds("p1", 5);
    assert.ok(seenPath.includes("/apps/p1/builds?limit=5"));

    const rotated = await client.rotate();
    assert.strictEqual(rotated.token, "adp_new");
  } finally {
    await server.close();
  }
});

test("pollDeviceAuth swallows authorization_pending and slow_down as null, not an error", async () => {
  let code = "authorization_pending";
  const server = await startServer(async (req, res) => {
    await readBody(req);
    if (code === "granted") {
      return sendJson(res, 200, {
        access_token: "adp_granted",
        token_id: "tok1",
        hint: "adp_x_••••",
        app_ids: ["p1"],
        app_names: ["Checkout"],
        expires_at: 999,
      });
    }
    sendJson(res, 400, { error: { code, message: code } });
  });
  try {
    const client = new AppDropperClient(server.baseUrl);
    assert.strictEqual(await client.pollDeviceAuth("dc1"), null);
    code = "slow_down";
    assert.strictEqual(await client.pollDeviceAuth("dc1"), null);
    code = "granted";
    const granted = await client.pollDeviceAuth("dc1");
    assert.strictEqual(granted.access_token, "adp_granted");
  } finally {
    await server.close();
  }
});

test("pollDeviceAuth lets a real failure (e.g. denied) propagate", async () => {
  const server = await startServer(async (req, res) => {
    await readBody(req);
    sendJson(res, 400, { error: { code: "access_denied", message: "The code was denied." } });
  });
  try {
    const client = new AppDropperClient(server.baseUrl);
    await assert.rejects(
      () => client.pollDeviceAuth("dc1"),
      (err) => err instanceof ApiError && err.code === "access_denied"
    );
  } finally {
    await server.close();
  }
});

test("awaitUpload returns immediately once the server reports ready", async () => {
  const server = await startServer((req, res) => {
    sendJson(res, 200, { upload_id: "u1", status: "ready", version: "1.0" });
  });
  try {
    const client = new AppDropperClient(server.baseUrl, "adp_x");
    const status = await client.awaitUpload("u1", 5000);
    assert.strictEqual(status.status, "ready");
  } finally {
    await server.close();
  }
});

test("awaitUpload returns immediately on an error status", async () => {
  const server = await startServer((req, res) => {
    sendJson(res, 200, { upload_id: "u1", status: "error", error: { code: "bad_binary", message: "Corrupt." } });
  });
  try {
    const client = new AppDropperClient(server.baseUrl, "adp_x");
    const status = await client.awaitUpload("u1", 5000);
    assert.strictEqual(status.status, "error");
    assert.strictEqual(status.error.message, "Corrupt.");
  } finally {
    await server.close();
  }
});

test("awaitUpload polls again when the first response is still processing", async () => {
  let calls = 0;
  const server = await startServer((req, res) => {
    calls++;
    sendJson(res, 200, { upload_id: "u1", status: calls === 1 ? "processing" : "ready" });
  });
  try {
    const client = new AppDropperClient(server.baseUrl, "adp_x");
    const status = await client.awaitUpload("u1", 5000);
    assert.strictEqual(status.status, "ready");
    assert.strictEqual(calls, 2);
  } finally {
    await server.close();
  }
});

test("awaitUpload gives back the last known status once its deadline passes", async () => {
  const server = await startServer((req, res) => {
    sendJson(res, 200, { upload_id: "u1", status: "processing" });
  });
  try {
    const client = new AppDropperClient(server.baseUrl, "adp_x");
    const status = await client.awaitUpload("u1", 30);
    assert.strictEqual(status.status, "processing");
  } finally {
    await server.close();
  }
});

test("uploadFile sends the whole file in one PUT on a clean connection", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "appdropper-upload-"));
  const filePath = path.join(tmp, "app.apk");
  const content = Buffer.alloc(50_000, 7);
  fs.writeFileSync(filePath, content);

  let received = Buffer.alloc(0);
  const server = await startServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received = Buffer.concat(chunks);
      res.writeHead(200);
      res.end();
    });
  });
  try {
    const progress = [];
    await uploadFile(`${server.baseUrl}/gcs/u1`, filePath, "application/octet-stream", content.length, (t) =>
      progress.push(t)
    );
    assert.strictEqual(received.length, content.length);
    assert.ok(received.equals(content));
    assert.strictEqual(progress[progress.length - 1], content.length);
  } finally {
    await server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("uploadFile resumes from where a dropped connection left off", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "appdropper-upload-"));
  const filePath = path.join(tmp, "app.apk");
  const total = 300_000;
  const content = Buffer.alloc(total);
  for (let i = 0; i < total; i++) content[i] = i % 256;
  fs.writeFileSync(filePath, content);

  const DROP_AFTER = 100_000;
  let storedBytes = 0;
  let dropped = false;
  let finalOffset = null;
  let finalBody = Buffer.alloc(0);
  let attempts = 0;

  const server = await startServer((req, res) => {
    const contentRange = req.headers["content-range"];
    if (req.method === "PUT" && contentRange && /^bytes \*\//.test(String(contentRange))) {
      // queryOffset probe: no body follows.
      if (storedBytes > 0) {
        res.writeHead(308, { Range: `bytes=0-${storedBytes - 1}` });
      } else {
        res.writeHead(308);
      }
      res.end();
      return;
    }

    attempts++;
    let offset = 0;
    if (contentRange) {
      const m = String(contentRange).match(/^bytes (\d+)-/);
      if (m) offset = Number(m[1]);
    }
    const chunks = [];
    let receivedInThisRequest = 0;
    req.on("data", (chunk) => {
      chunks.push(chunk);
      receivedInThisRequest += chunk.length;
      if (!dropped && offset + receivedInThisRequest >= DROP_AFTER) {
        dropped = true;
        storedBytes = offset + receivedInThisRequest;
        req.socket.destroy();
      }
    });
    req.on("end", () => {
      if (req.socket.destroyed) return;
      finalOffset = offset;
      finalBody = Buffer.concat(chunks);
      res.writeHead(200);
      res.end();
    });
  });

  try {
    const progress = [];
    await uploadFile(`${server.baseUrl}/gcs/u1`, filePath, "application/octet-stream", total, (t) =>
      progress.push(t)
    );
    assert.ok(attempts >= 2, "the drop must have forced a second attempt");
    assert.strictEqual(
      finalOffset,
      storedBytes,
      "the resumed request must start exactly where the dropped connection left off"
    );
    assert.strictEqual(finalOffset + finalBody.length, total, "together the two attempts cover the whole file");
    assert.ok(finalBody.equals(content.subarray(finalOffset)));
  } finally {
    await server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

(async () => {
  let failed = 0;
  console.log("\nAppDropperClient + resumable upload\n");
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
