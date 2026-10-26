import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { flag, type ParsedArgs } from "../args";
import { CliError, EXIT } from "../errors";
import { color, info, warn } from "../ui";
import { requireToken } from "./login";
import { uploadCommand } from "./upload";

/**
 * `appdropper flutter build apk|ipa …` — runs the Flutter build the developer
 * already types every day, then uploads whatever it produced.
 *
 * Every argument goes to Flutter untouched except App Dropper's own upload
 * flags, which Flutter's build commands don't use, so a single line can carry
 * both: `appdropper flutter build apk --release --flavor prod --notes "…"`.
 */

const VALUE_FLAGS = ["notes", "release-notes", "releaseNotes", "tag", "group", "token", "timeout"];
const BOOL_FLAGS = ["json", "no-qr", "noQr"];

const USAGE = "Usage: appdropper flutter build apk|ipa [flutter options]";

export async function flutterCommand(argv: string[]): Promise<void> {
  const { flutterArgs, uploadArgs } = splitFlutterArgs(argv);

  const target = buildTarget(flutterArgs);
  if (target === undefined) throw new CliError(USAGE, EXIT.USAGE);
  checkTarget(target);

  // Sign in (or fail) before a several-minute build, not after it.
  await requireToken(flag(uploadArgs, ["token"]), uploadArgs);

  if (
    target === "ipa" &&
    !flutterArgs.some((a) => /^--export-(method|options-plist)\b/.test(a))
  ) {
    warn(
      "flutter build ipa exports for the App Store by default, which testers can't install. " +
        "Add --export-method ad-hoc (or development) to share it."
    );
  }

  info(color.dim(`$ flutter ${flutterArgs.join(" ")}`));
  const { code, output } = await runFlutter(flutterArgs);
  if (code !== 0) {
    // Exit codes are the CLI's contract (3 means "token is dead"), so Flutter's
    // own code goes in the message rather than out of the process.
    throw new CliError(`flutter build failed (exit ${code}). Nothing was uploaded.`, EXIT.FAILURE);
  }

  const built = builtPaths(output);
  const file = pickBuild(built, process.cwd());
  if (!file) {
    // `flutter build ipa` exits 0 when the archive succeeds but the export
    // doesn't, so a clean exit alone doesn't mean there's a file to send.
    throw new CliError(
      `Flutter finished but didn't report a built .${target}. Nothing was uploaded.`,
      EXIT.FAILURE
    );
  }
  if (built.length > 1) {
    info(color.dim(`Flutter built ${built.length} files; uploading ${path.basename(file)}.`));
  }

  info();
  await uploadCommand({ positionals: [file], flags: uploadArgs.flags });
}

/** Pulls App Dropper's own flags out; everything else is Flutter's. */
export function splitFlutterArgs(argv: string[]): {
  flutterArgs: string[];
  uploadArgs: ParsedArgs;
} {
  const flutterArgs: string[] = [];
  const flags: ParsedArgs["flags"] = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // Long forms only: Flutter owns the short ones (`-t` is its --target).
    const match = /^--([^=]+)(?:=(.*))?$/s.exec(arg);
    const name = match?.[1] ?? "";
    if (VALUE_FLAGS.includes(name)) {
      if (match![2] !== undefined) {
        flags[name] = match![2];
      } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("-")) {
        flags[name] = argv[++i];
      } else {
        flags[name] = true;
      }
    } else if (BOOL_FLAGS.includes(name) && match![2] === undefined) {
      flags[name] = true;
    } else {
      flutterArgs.push(arg);
    }
  }

  return { flutterArgs, uploadArgs: { positionals: [], flags } };
}

/** The word after `build` — `apk` in `flutter build apk --release`. */
export function buildTarget(flutterArgs: string[]): string | undefined {
  const at = flutterArgs.indexOf("build");
  if (at === -1) return undefined;
  return flutterArgs.slice(at + 1).find((a) => !a.startsWith("-"));
}

function checkTarget(target: string): void {
  if (target === "apk" || target === "ipa") return;
  if (target === "appbundle" || target === "aab") {
    throw new CliError(
      "App Dropper installs .apk and .ipa files, not .aab bundles. Use `appdropper flutter build apk`, " +
        "or run `flutter build appbundle` directly for Google Play.",
      EXIT.USAGE
    );
  }
  if (target === "ios") {
    throw new CliError(
      "`flutter build ios` makes a .app, which phones can't install from a link. " +
        "Use `appdropper flutter build ipa`.",
      EXIT.USAGE
    );
  }
  throw new CliError(`App Dropper can't install "${target}" builds. ${USAGE}`, EXIT.USAGE);
}

const ANSI = /\u001b\[[0-9;]*m/g;
// "✓ Built build/app/outputs/flutter-apk/app-release.apk (61.5MB)"
// "✓ Built IPA to build/ios/ipa (24.0MB)"
const BUILT = /^(?:[✓√]\s*)?Built (IPA to )?(.+?)(?:\s+\([^()]*B\))?\.?$/;

/** Every output Flutter announced, in the order it announced them. */
export function builtPaths(output: string): string[] {
  const paths: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const match = BUILT.exec(raw.replace(ANSI, "").trim());
    if (match) paths.push(match[2]);
  }
  return paths;
}

/**
 * The one file to upload. `--split-per-abi` announces an APK per CPU type;
 * arm64 is what nearly every phone in a tester's hand runs. `flutter build
 * ipa` announces a directory, which holds the .ipa.
 */
export function pickBuild(paths: string[], cwd: string): string | undefined {
  const files: string[] = [];
  for (const p of paths) {
    const abs = path.resolve(cwd, p);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const ipa = newestIpa(abs);
      if (ipa) files.push(ipa);
    } else if (/\.(apk|ipa)$/i.test(abs)) {
      files.push(abs);
    }
  }
  return files.find((f) => /arm64-v8a/.test(path.basename(f))) ?? files[0];
}

function newestIpa(dir: string): string | undefined {
  return fs
    .readdirSync(dir)
    .filter((name) => /\.ipa$/i.test(name))
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

/**
 * Flutter's output is streamed through as it arrives — to stderr, so stdout
 * stays the install link (or `--json`) exactly as with `upload`.
 */
function runFlutter(args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("flutter", args, {
      stdio: ["inherit", "pipe", "pipe"],
      // `flutter` is a .bat on Windows, which only a shell can start.
      shell: process.platform === "win32",
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.on("error", (err: NodeJS.ErrnoException) => {
      reject(
        err.code === "ENOENT"
          ? new CliError("Couldn't find `flutter` on your PATH.", EXIT.USAGE)
          : err
      );
    });
    child.on("close", (code) => resolve({ code: code ?? EXIT.FAILURE, output }));
  });
}
