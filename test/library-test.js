"use strict";
/**
 * Covers `appdropper/api` — the library surface the MCP server builds on —
 * loaded through the package's own `exports` map, exactly as a dependent
 * package resolves it. A local HTTP server stands in for the API and the GCS
 * resumable session.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const assert = require("assert");

const lib = require("appdropper/api");
const {
  AbortError,
  ApiError,
  AppDropperClient,
  BuildFileError,
  BuildProcessingError,
  StillProcessingError,
  TransferError,
  inspectBuildFile,
  resolveTokenWithSource,
  uploadBuild,
} = lib;

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => {
          server.closeAllConnections?.();
          return new Promise((r) => server.close(r));
        },
      });
    });
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function drain(req) {
  return new Promise((resolve) => {
    let bytes = 0;
    req.on("data", (c) => (bytes += c.length));
    req.on("end", () => resolve(bytes));
  });
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "adp-lib-"));
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ------------------------------------------------------------ the export map

test("appdropper/api resolves through the exports map and exposes the upload flow", () => {
  for (const name of [
    "AppDropperClient",
    "uploadBuild",
    "inspectBuildFile",
    "resolveTokenWithSource",
    "apiUrl",
    "detectCi",
  ]) {
    assert.ok(lib[name], `missing export ${name}`);
  }
  assert.ok(fs.existsSync(require.resolve("appdropper/api").replace(/\.js$/, ".d.ts")), "no type declarations");
});

// ---------------------------------------------------------- inspectBuildFile

test("inspectBuildFile accepts relative and absolute .apk/.ipa paths, spaces included", () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, "My Builds"));
    fs.writeFileSync(path.join(dir, "My Builds", "app release.apk"), "apk");
    fs.writeFileSync(path.join(dir, "Runner.IPA"), "ipa");

    const relative = inspectBuildFile("My Builds/app release.apk", dir);
    assert.strictEqual(relative.platform, "android");
    assert.strictEqual(relative.fileName, "app release.apk");
    assert.strictEqual(relative.size, 3);
    assert.ok(path.isAbsolute(relative.path));

    const absolute = inspectBuildFile(path.join(dir, "Runner.IPA"));
    assert.strictEqual(absolute.platform, "ios", "extension matching is case-insensitive");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("inspectBuildFile refuses missing files, directories, other types and empty files", () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, "notes.txt"), "x");
    fs.writeFileSync(path.join(dir, "empty.apk"), "");
    fs.mkdirSync(path.join(dir, "folder.apk"));
    const code = (p) => {
      try {
        inspectBuildFile(p, dir);
      } catch (err) {
        assert.ok(err instanceof BuildFileError);
        return err.code;
      }
      return "accepted";
    };
    assert.strictEqual(code("missing.apk"), "not_found");
    assert.strictEqual(code("folder.apk"), "not_a_file");
    assert.strictEqual(code("notes.txt"), "unsupported_type");
    assert.strictEqual(code("empty.apk"), "empty");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("inspectBuildFile judges a symlink by its target, not its name", () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, "secrets.txt"), "x");
    fs.symlinkSync(path.join(dir, "secrets.txt"), path.join(dir, "latest.apk"));
    assert.throws(() => inspectBuildFile("latest.apk", dir), (err) => err.code === "unsupported_type");

    fs.writeFileSync(path.join(dir, "real.apk"), "apk");
    fs.symlinkSync(path.join(dir, "real.apk"), path.join(dir, "current.apk"));
    const resolved = inspectBuildFile("current.apk", dir);
    assert.strictEqual(resolved.fileName, "real.apk");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------- resolveTokenWithSource

test("token precedence is argument, then APPDROPPER_TOKEN, then the saved login", () => {
  const dir = tmpDir();
  const saved = { ...process.env };
  try {
    process.env.APPDROPPER_CONFIG_DIR = dir;
    delete process.env.APPDROPPER_TOKEN;
    fs.writeFileSync(
      path.join(dir, "config"),
      JSON.stringify({ credentials: { "https://x/api/v1": { token: "adp_saved_x" } } })
    );
    assert.deepStrictEqual(resolveTokenWithSource("https://x/api/v1"), {
      token: "adp_saved_x",
      source: "saved login",
    });
    process.env.APPDROPPER_TOKEN = "adp_env_x";
    assert.strictEqual(resolveTokenWithSource("https://x/api/v1").source, "APPDROPPER_TOKEN");
    assert.strictEqual(resolveTokenWithSource("https://x/api/v1", "adp_arg_x").source, "argument");
    process.env.APPDROPPER_TOKEN = "   ";
    assert.strictEqual(
      resolveTokenWithSource("https://x/api/v1").source,
      "saved login",
      "a blank variable must not shadow a real login"
    );
    assert.strictEqual(resolveTokenWithSource("https://elsewhere/api/v1"), null);
  } finally {
    process.env = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- uploadBuild

/** A fake API whose upload finishes with `finalStatus`. */
async function fakeApi(finalStatus, { onPut, reserveStatus } = {}) {
  const seen = { reserve: null, puts: 0, userAgents: [] };
  const server = await startServer(async (req, res) => {
    seen.userAgents.push(req.headers["user-agent"]);
    if (req.method === "POST" && req.url === "/uploads") {
      let body = "";
      req.on("data", (c) => (body += c));
      await new Promise((r) => req.on("end", r));
      seen.reserve = JSON.parse(body);
      if (reserveStatus) return sendJson(res, reserveStatus.status, reserveStatus.body);
      return sendJson(res, 201, {
        upload_id: "up1",
        upload_url: `${server.baseUrl}/session`,
        content_type: "application/octet-stream",
      });
    }
    if (req.method === "PUT" && req.url === "/session") {
      seen.puts += 1;
      if (onPut) return onPut(req, res);
      await drain(req);
      res.writeHead(200);
      return res.end();
    }
    if (req.method === "GET" && req.url.startsWith("/uploads/up1")) {
      return sendJson(res, 200, finalStatus);
    }
    sendJson(res, 404, { error: { code: "not_found", message: req.url } });
  });
  return { server, seen };
}

function buildFile(bytes = 4096) {
  const dir = tmpDir();
  const file = path.join(dir, "app.apk");
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
  return { dir, file: inspectBuildFile(file) };
}

test("uploadBuild reserves, streams, waits, and returns the ready build", async () => {
  const ready = {
    upload_id: "up1",
    status: "ready",
    build_id: "b1",
    app_name: "Acme",
    version: "2.4.1",
    build_number: "318",
    install_url: "https://appdropper.io/acme?build=b1",
  };
  const { server, seen } = await fakeApi(ready);
  const { dir, file } = buildFile();
  const phases = [];
  let lastProgress = 0;
  try {
    const result = await uploadBuild({
      client: new AppDropperClient(server.baseUrl, "adp_t_x", { userAgent: "appdropper-mcp/0.1.0" }),
      file,
      releaseNotes: "Fix login",
      tag: "beta",
      userAgent: "appdropper-mcp/0.1.0",
      onPhase: (p) => phases.push(p),
      onProgress: (sent) => (lastProgress = sent),
    });
    assert.strictEqual(result.install_url, ready.install_url);
    assert.deepStrictEqual(phases, ["reserving", "uploading", "processing"]);
    assert.strictEqual(lastProgress, file.size);
    assert.strictEqual(seen.reserve.release_notes, "Fix login");
    assert.strictEqual(seen.reserve.tag, "beta");
    assert.strictEqual(seen.reserve.ci, undefined, "no CI info unless the caller passes it");
    assert.ok(seen.userAgents.every((ua) => ua === "appdropper-mcp/0.1.0"), seen.userAgents.join());
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("uploadBuild surfaces a 402 from the reservation as an ApiError, before any bytes move", async () => {
  const { server, seen } = await fakeApi(null, {
    reserveStatus: {
      status: 402,
      body: { error: { code: "upgrade_required", message: "This build is 620 MB. Upgrade to Pro." } },
    },
  });
  const { dir, file } = buildFile();
  try {
    await assert.rejects(
      () => uploadBuild({ client: new AppDropperClient(server.baseUrl, "adp_t_x"), file }),
      (err) => err instanceof ApiError && err.status === 402 && err.code === "upgrade_required"
    );
    assert.strictEqual(seen.puts, 0);
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("uploadBuild reports a rejected binary as BuildProcessingError with the server's code", async () => {
  const { server } = await fakeApi({
    upload_id: "up1",
    status: "error",
    error: { code: "upgrade_required", message: "That would be app number 6." },
  });
  const { dir, file } = buildFile();
  try {
    await assert.rejects(
      () => uploadBuild({ client: new AppDropperClient(server.baseUrl, "adp_t_x"), file }),
      (err) =>
        err instanceof BuildProcessingError &&
        err.code === "upgrade_required" &&
        err.uploadId === "up1" &&
        /app number 6/.test(err.message)
    );
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("uploadBuild reports a timeout as StillProcessingError, not a failure", async () => {
  const { server } = await fakeApi({ upload_id: "up1", status: "processing" });
  const { dir, file } = buildFile();
  try {
    await assert.rejects(
      () =>
        uploadBuild({ client: new AppDropperClient(server.baseUrl, "adp_t_x"), file, timeoutMs: 1 }),
      (err) => err instanceof StillProcessingError && err.uploadId === "up1"
    );
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("uploadBuild wraps a storage failure in TransferError after its retries", async () => {
  const { server } = await fakeApi(null, {
    onPut: async (req, res) => {
      if (req.headers["content-range"]?.startsWith("bytes */")) {
        res.writeHead(410);
        return res.end();
      }
      await drain(req);
      res.writeHead(503);
      res.end("storage unavailable");
    },
  });
  const { dir, file } = buildFile();
  try {
    await assert.rejects(
      () => uploadBuild({ client: new AppDropperClient(server.baseUrl, "adp_t_x"), file }),
      (err) => err instanceof TransferError && err.uploadId === "up1" && /HTTP 503/.test(err.message)
    );
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("aborting mid-upload stops the transfer and is never retried", async () => {
  const controller = new AbortController();
  let putsAfterAbort = 0;
  const { server, seen } = await fakeApi(null, {
    onPut: (req) => {
      if (controller.signal.aborted) putsAfterAbort += 1;
      // Accept a little, then hang: the client must be the one to stop.
      req.once("data", () => controller.abort());
    },
  });
  const { dir, file } = buildFile(4 * 1024 * 1024);
  try {
    await assert.rejects(
      () =>
        uploadBuild({
          client: new AppDropperClient(server.baseUrl, "adp_t_x", { signal: controller.signal }),
          file,
          signal: controller.signal,
        }),
      (err) => err instanceof AbortError
    );
    assert.strictEqual(seen.puts, 1, "an aborted upload must not be resumed");
    assert.strictEqual(putsAfterAbort, 0);
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a client-level signal cancels a held long-poll", async () => {
  const controller = new AbortController();
  const server = await startServer(() => {
    // Never answers — like the server holding `?wait=120`.
    setTimeout(() => controller.abort(), 50);
  });
  try {
    const client = new AppDropperClient(server.baseUrl, "adp_t_x", { signal: controller.signal });
    const started = Date.now();
    await assert.rejects(() => client.awaitUpload("up1", 60_000), (err) => err instanceof AbortError);
    assert.ok(Date.now() - started < 5000, "the abort did not interrupt the request");
  } finally {
    await server.close();
  }
});

// --------------------------------------------------------- listApps/getBuild

test("listApps and getBuild call the production endpoints", async () => {
  const urls = [];
  const server = await startServer((req, res) => {
    urls.push(req.url);
    if (req.url === "/apps") {
      return sendJson(res, 200, { token_id: "t", all_apps: true, apps: [{ app_id: "a1" }] });
    }
    return sendJson(res, 200, { build_id: "b1", app_id: "a1", install_url: "u" });
  });
  try {
    const client = new AppDropperClient(server.baseUrl, "adp_t_x");
    const apps = await client.listApps();
    assert.strictEqual(apps.all_apps, true);
    const build = await client.getBuild("b 1", "a1");
    assert.strictEqual(build.build_id, "b1");
    assert.deepStrictEqual(urls, ["/apps", "/builds/b%201?app_id=a1"]);
  } finally {
    await server.close();
  }
});

(async () => {
  let failed = 0;
  console.log("\nappdropper/api — the library the MCP server uses\n");
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
