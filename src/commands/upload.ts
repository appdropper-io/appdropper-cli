import * as fs from "fs";
import * as path from "path";
import { boolFlag, flag, type ParsedArgs } from "../args";
import { detectCi } from "../ci";
import { AppDropperClient, ApiError, uploadFile } from "../client";
import { apiUrl, resolveToken } from "../config";
import { CliError, EXIT } from "../errors";
import { color, info, out, printQr, progressBar, spinner, success } from "../ui";

/** How long to wait for parsing before handing back control. */
const DEFAULT_PROCESS_TIMEOUT_MS = 10 * 60 * 1000;

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

  const filePath = path.resolve(file);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    throw new CliError(`No such file: ${filePath}`, EXIT.USAGE);
  }
  if (!stats.isFile()) throw new CliError(`Not a file: ${filePath}`, EXIT.USAGE);

  const fileName = path.basename(filePath);
  const extension = path.extname(fileName).toLowerCase();
  if (extension !== ".apk" && extension !== ".ipa") {
    throw new CliError(
      `Only .apk and .ipa builds can be uploaded (got ${extension || "no extension"}).`,
      EXIT.USAGE
    );
  }

  const json = boolFlag(args, ["json"]);
  const noQr = boolFlag(args, ["no-qr", "noQr"]);
  const notes = flag(args, ["notes", "n", "release-notes", "releaseNotes"]) ?? "";
  // `--group` is accepted because that is what people migrating from Diawi
  // reach for; it lands on the build's tag, which is what App Dropper actually
  // models. Tester routing by group isn't a feature yet.
  const tag = flag(args, ["tag", "group"]) ?? "";
  const timeoutMs = Number(flag(args, ["timeout"]) ?? 0) * 1000 || DEFAULT_PROCESS_TIMEOUT_MS;

  const client = new AppDropperClient(base, token);

  if (!json) {
    info(
      `${color.violet("App Dropper")} ${color.dim(`· ${fileName} (${humanSize(stats.size)})`)}`
    );
  }

  // 1. Reserve the slot. Every plan limit, quota and rate limit is applied
  //    here, so a ticket coming back means the bytes are welcome.
  let ticket;
  try {
    ticket = await client.createUpload({
      fileName,
      fileSize: stats.size,
      releaseNotes: notes,
      tag,
      // Read off the runner's environment. On a laptop this is undefined and
      // the field is simply omitted.
      ci: detectCi(),
    });
  } catch (err) {
    throw asCliError(err);
  }

  // 2. Send the binary straight to storage — it never passes through the API.
  const bar = json ? null : progressBar("Uploading", stats.size);
  try {
    await uploadFile(
      ticket.upload_url,
      filePath,
      ticket.content_type,
      stats.size,
      (sent) => bar?.update(sent)
    );
    bar?.done();
  } catch (err) {
    bar?.done();
    throw new CliError(
      `Upload failed: ${err instanceof Error ? err.message : String(err)}`,
      EXIT.FAILURE
    );
  }

  // 3. Wait for the server to parse it and mint the install link.
  const spin = json ? null : spinner("Processing build");
  let status;
  try {
    status = await client.awaitUpload(ticket.upload_id, timeoutMs);
  } catch (err) {
    spin?.stop();
    throw asCliError(err);
  }
  spin?.stop();

  if (status.status === "error") {
    throw new CliError(
      status.error?.message ?? "This build could not be processed.",
      EXIT.FAILURE
    );
  }
  if (status.status !== "ready") {
    throw new CliError(
      "The build is still processing. Check your dashboard in a moment — nothing was lost.",
      EXIT.FAILURE
    );
  }

  if (json) {
    out(JSON.stringify(status, null, 2));
    return;
  }

  const installUrl = status.install_url ?? "";
  info();
  success(
    `${color.bold(status.app_name ?? fileName)} ${status.version ?? ""}${
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
  return new CliError(err instanceof Error ? err.message : String(err), EXIT.FAILURE);
}
