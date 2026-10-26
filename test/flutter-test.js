"use strict";
/**
 * Covers `appdropper flutter build …`: splitting App Dropper's flags from
 * Flutter's, reading the built file out of Flutter's output, refusing targets
 * App Dropper can't install, and the whole build → upload run against a fake
 * `flutter` on PATH and a fake API.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const assert = require("assert");

const DIST = path.resolve(__dirname, "..", "dist");
const {
  flutterCommand,
  splitFlutterArgs,
  buildTarget,
  builtPaths,
  pickBuild,
} = require(path.join(DIST, "commands/flutter.js"));
const { EXIT, CliError } = require(path.join(DIST, "errors.js"));

// A missing token at a terminal starts a browser sign-in. These tests are
// about the other path, so they must not look like a terminal even when run
// from one.
process.stdin.isTTY = false;

let workDir;
let originalPath;
let originalCwd;
function setup() {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "appdropper-cli-flutter-test-"));
  process.env.APPDROPPER_CONFIG_DIR = path.join(workDir, "config");
  delete process.env.APPDROPPER_TOKEN;
  originalPath = process.env.PATH;
  originalCwd = process.cwd();
  process.chdir(workDir);
}
function teardown() {
  process.chdir(originalCwd);
  process.env.PATH = originalPath;
  delete process.env.APPDROPPER_CONFIG_DIR;
  delete process.env.APPDROPPER_TOKEN;
  delete process.env.APPDROPPER_API_URL;
  fs.rmSync(workDir, { recursive: true, force: true });
}

/** Puts a `flutter` on PATH that runs `script` (sh) and logs its argv. */
function fakeFlutter(script) {
  const bin = path.join(workDir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const file = path.join(bin, "flutter");
  fs.writeFileSync(file, `#!/bin/sh\necho "$@" > "${workDir}/argv.txt"\n${script}\n`);
  fs.chmodSync(file, 0o755);
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
}

function startServer() {
  let uploaded = 0;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const json = (body) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/uploads") {
          return json({ upload_id: "u1", upload_url: `${base}/gcs/u1`, content_type: "application/vnd.android.package-archive", app_id: "p1", app_name: "Shop" });
        }
        if (req.method === "PUT") {
          uploaded = Buffer.concat(chunks).length;
          res.writeHead(200);
          return res.end();
        }
        json({ upload_id: "u1", status: "ready", app_name: "Shop", install_url: `${base}/d/shop` });
      });
    });
    let base;
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve({ baseUrl: base, uploaded: () => uploaded, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

async function quietly(fn) {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  let stdout = "";
  process.stdout.write = (c) => ((stdout += c), true);
  process.stderr.write = () => true;
  try {
    await fn();
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  return stdout;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("App Dropper's long flags are pulled out; everything else goes to Flutter", () => {
  const { flutterArgs, uploadArgs } = splitFlutterArgs([
    "build", "apk", "--release", "--flavor", "prod", "-t", "lib/main_prod.dart",
    "--notes", "Fixed checkout", "--tag=beta", "--json", "--dart-define=A=B",
  ]);
  assert.deepStrictEqual(flutterArgs, [
    "build", "apk", "--release", "--flavor", "prod", "-t", "lib/main_prod.dart", "--dart-define=A=B",
  ]);
  assert.deepStrictEqual(uploadArgs.flags, { notes: "Fixed checkout", tag: "beta", json: true });
});

test("the build target is the word after `build`, past any global flags", () => {
  assert.strictEqual(buildTarget(["build", "apk", "--release"]), "apk");
  assert.strictEqual(buildTarget(["-v", "build", "--release", "ipa"]), "ipa");
  assert.strictEqual(buildTarget(["run"]), undefined);
});

test("reads apk, split-per-abi and IPA lines out of Flutter's output", () => {
  const output = [
    "Running Gradle task 'assembleRelease'...                          213.5s",
    "\u001b[32m✓ Built build/app/outputs/flutter-apk/app-release.apk (61.5MB)\u001b[0m",
    "✓ Built build/app/outputs/flutter-apk/app-debug.apk",
    "✓ Built IPA to build/ios/ipa (24.0MB)",
    "Built IPA to /abs/build/ios/ipa.",
  ].join("\n");
  assert.deepStrictEqual(builtPaths(output), [
    "build/app/outputs/flutter-apk/app-release.apk",
    "build/app/outputs/flutter-apk/app-debug.apk",
    "build/ios/ipa",
    "/abs/build/ios/ipa",
  ]);
});

test("prefers the arm64 APK from --split-per-abi and finds the .ipa in its folder", () => {
  setup();
  try {
    const apkDir = path.join(workDir, "apk");
    fs.mkdirSync(apkDir);
    for (const abi of ["armeabi-v7a", "arm64-v8a", "x86_64"]) {
      fs.writeFileSync(path.join(apkDir, `app-${abi}-release.apk`), "x");
    }
    const picked = pickBuild(
      ["armeabi-v7a", "arm64-v8a", "x86_64"].map((abi) => `apk/app-${abi}-release.apk`),
      workDir
    );
    assert.strictEqual(path.basename(picked), "app-arm64-v8a-release.apk");

    fs.mkdirSync(path.join(workDir, "ipa"));
    fs.writeFileSync(path.join(workDir, "ipa", "Shop.ipa"), "x");
    assert.strictEqual(pickBuild(["ipa"], workDir), path.join(workDir, "ipa", "Shop.ipa"));
    assert.strictEqual(pickBuild(["missing.apk"], workDir), undefined);
  } finally {
    teardown();
  }
});

test("refuses appbundle and ios before building anything", async () => {
  setup();
  process.env.APPDROPPER_TOKEN = "adp_x";
  fakeFlutter("exit 0");
  try {
    for (const [target, pattern] of [["appbundle", /not \.aab/], ["ios", /build ipa/], ["web", /can't install/]]) {
      await assert.rejects(
        () => flutterCommand(["build", target]),
        (err) => err instanceof CliError && err.exitCode === EXIT.USAGE && pattern.test(err.message)
      );
    }
    assert.ok(!fs.existsSync(path.join(workDir, "argv.txt")), "flutter must not have run");
  } finally {
    teardown();
  }
});

test("asks for a token before starting a long build", async () => {
  setup();
  fakeFlutter("exit 0");
  try {
    await assert.rejects(
      () => flutterCommand(["build", "apk"]),
      (err) => err instanceof CliError && err.exitCode === EXIT.AUTH
    );
    assert.ok(!fs.existsSync(path.join(workDir, "argv.txt")), "flutter must not have run");
  } finally {
    teardown();
  }
});

test("a failed build exits 1, names Flutter's code, and uploads nothing", async () => {
  setup();
  process.env.APPDROPPER_TOKEN = "adp_x";
  fakeFlutter("echo 'Gradle task assembleRelease failed'; exit 3");
  try {
    await assert.rejects(
      () => quietly(() => flutterCommand(["build", "apk"])),
      (err) => err instanceof CliError && err.exitCode === EXIT.FAILURE && /exit 3\). Nothing was uploaded/.test(err.message)
    );
  } finally {
    teardown();
  }
});

test("a clean exit with no built file (failed IPA export) is still a failure", async () => {
  setup();
  process.env.APPDROPPER_TOKEN = "adp_x";
  fakeFlutter("echo 'Encountered error while creating the IPA'; exit 0");
  try {
    await assert.rejects(
      () => quietly(() => flutterCommand(["build", "ipa", "--export-method", "ad-hoc"])),
      (err) => err instanceof CliError && err.exitCode === EXIT.FAILURE && /didn't report/.test(err.message)
    );
  } finally {
    teardown();
  }
});

test("builds with the exact Flutter args, then uploads the file it announced", async () => {
  setup();
  const server = await startServer();
  process.env.APPDROPPER_API_URL = server.baseUrl;
  process.env.APPDROPPER_TOKEN = "adp_x";
  fakeFlutter(
    [
      "mkdir -p build/app/outputs/flutter-apk",
      "head -c 5000 /dev/zero > build/app/outputs/flutter-apk/app-prod-release.apk",
      "echo '✓ Built build/app/outputs/flutter-apk/app-prod-release.apk (0.0MB)'",
    ].join("\n")
  );
  try {
    const stdout = await quietly(() =>
      flutterCommand(["build", "apk", "--release", "--flavor", "prod", "--notes", "hi", "--no-qr"])
    );
    assert.strictEqual(
      fs.readFileSync(path.join(workDir, "argv.txt"), "utf8").trim(),
      "build apk --release --flavor prod"
    );
    assert.strictEqual(server.uploaded(), 5000);
    assert.strictEqual(stdout.trim(), `${server.baseUrl}/d/shop`, "stdout carries only the install link");
  } finally {
    await server.close();
    teardown();
  }
});

(async () => {
  let failed = 0;
  console.log("\nflutter build → upload\n");
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
