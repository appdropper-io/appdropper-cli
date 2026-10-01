import * as fs from "fs";
import { boolFlag, flag, type ParsedArgs } from "../args";
import { detectCi } from "../ci";
import { AppDropperClient, ApiError } from "../client";
import { apiUrl, resolveToken } from "../config";
import { CliError, EXIT } from "../errors";
import {
  BuildFileError,
  BuildProcessingError,
  DEFAULT_PROCESS_TIMEOUT_MS,
  StillProcessingError,
  TransferError,
  inspectBuildFile,
  uploadBuild,
  type BuildFile,
} from "../upload-build";
import { color, info, out, printQr, progressBar, spinner, success } from "../ui";

export async function uploadCommand(args: ParsedArgs): Promise<void> {
  const base = apiUrl();
  const file = args.positionals[0];
  if (!file) {
    throw new CliError(
      "Which file? Usage: appdropper upload <path-to-.apk-or-.ipa>",
      EXIT.USAGE
    );
  }

  const token = resolveToken(base, flag(args, ["token", "t"]));
  if (!token) {
    throw new CliError(
      "No API token. Set APPDROPPER_TOKEN, pass --token, or run `appdropper login`.",
      EXIT.AUTH
    );
  }

  let build: BuildFile;
  try {
    build = inspectBuildFile(file);
  } catch (err) {
    throw asCliError(err);
  }

  const json = boolFlag(args, ["json"]);
  const noQr = boolFlag(args, ["no-qr", "noQr"]);
  const notes = flag(args, ["notes", "n", "release-notes", "releaseNotes"]) ?? "";
  // `--group` is accepted because that is what people migrating from Diawi
  // reach for; it lands on the build's tag, which is what App Dropper actually
  // models. Tester routing by group isn't a feature yet.
  const tag = flag(args, ["tag", "group"]) ?? "";
  const timeoutMs = Number(flag(args, ["timeout"]) ?? 0) * 1000 || DEFAULT_PROCESS_TIMEOUT_MS;

  if (!json) {
    info(
      `${color.violet("App Dropper")} ${color.dim(`· ${build.fileName} (${humanSize(build.size)})`)}`
    );
  }

  const bar = json ? null : progressBar("Uploading", build.size);
  let spin: ReturnType<typeof spinner> | null = null;
  let status;
  try {
    status = await uploadBuild({
      client: new AppDropperClient(base, token),
      file: build,
      releaseNotes: notes,
      tag,
      // Read off the runner's environment. On a laptop this is undefined and
      // the field is simply omitted.
      ci: detectCi(),
      timeoutMs,
      onProgress: (sent) => bar?.update(sent),
      onPhase: (phase) => {
        if (phase !== "processing") return;
        bar?.done();
        if (!json) spin = spinner("Processing build");
      },
    });
  } catch (err) {
    bar?.done();
    throw asCliError(err);
  } finally {
    (spin as ReturnType<typeof spinner> | null)?.stop();
  }

  if (json) {
    out(JSON.stringify(status, null, 2));
    return;
  }

  const installUrl = status.install_url ?? "";
  info();
  success(
    `${color.bold(status.app_name ?? build.fileName)} ${status.version ?? ""}${
      status.build_number ? ` (${status.build_number})` : ""
    } is live`
  );
  info();
  if (!noQr && installUrl) printQr(installUrl);
  info(`  ${color.dim("Install link")}  ${color.cyan(installUrl)}`);
  if (status.expires_at) {
    info(`  ${color.dim("Expires")}       ${new Date(status.expires_at).toUTCString()}`);
  }
  info();

  // The install URL is the only thing on stdout, so `URL=$(appdropper upload
  // …)` does the obvious thing in a shell script.
  out(installUrl);

  writeGithubOutputs(status.build_id ?? "", installUrl, status.qr_url ?? "");
}

/**
 * When running inside GitHub Actions, publish the results as step outputs and
 * a job summary. Doing it here rather than in the Action's own wrapper means
 * a hand-written `run: npx appdropper upload …` step gets them too.
 */
function writeGithubOutputs(buildId: string, installUrl: string, qrUrl: string): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  try {
    fs.appendFileSync(
      outputFile,
      `install-url=${installUrl}\nbuild-id=${buildId}\nqr-url=${qrUrl}\n`
    );
  } catch {
    // Never fail an otherwise successful upload over a log-adjacent nicety.
  }
}

function humanSize(bytes: number): string {
  return bytes >= 1024 ** 2
    ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

/** Turns an API failure into an exit code a pipeline can branch on. */
export function asCliError(err: unknown): CliError {
  if (err instanceof ApiError) {
    const code =
      err.status === 401 || err.status === 403
        ? EXIT.AUTH
        : err.status === 429
          ? EXIT.RATE_LIMITED
          : EXIT.FAILURE;
    return new CliError(err.message, code);
  }
  if (err instanceof CliError) return err;
  if (err instanceof BuildFileError) return new CliError(err.message, EXIT.USAGE);
  if (err instanceof TransferError) return new CliError(`Upload failed: ${err.message}`, EXIT.FAILURE);
  if (err instanceof BuildProcessingError || err instanceof StillProcessingError) {
    return new CliError(err.message, EXIT.FAILURE);
  }
  return new CliError(err instanceof Error ? err.message : String(err), EXIT.FAILURE);
}
