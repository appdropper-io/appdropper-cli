import * as fs from "fs";
import * as path from "path";
import type { CiInfo } from "./ci";
import { AppDropperClient, uploadFile, type UploadStatus } from "./client";

/**
 * The one implementation of "send this build to App Dropper": check the file,
 * reserve a slot, stream the bytes to storage, wait for processing. The CLI's
 * `upload` command and the MCP server's `upload_build` tool both call this, so
 * a fix to the flow lands in both at once.
 *
 * It never prints. Progress comes back through callbacks and failures as typed
 * errors, so each caller decides how to show them — a terminal progress bar,
 * or MCP progress notifications on a stdout that must carry nothing else.
 */

export type BuildPlatform = "android" | "ios";

/** The only file types App Dropper accepts, and what each one is. */
export const BUILD_EXTENSIONS: Readonly<Record<string, BuildPlatform>> = {
  ".apk": "android",
  ".ipa": "ios",
};

export type BuildFileErrorCode = "not_found" | "not_a_file" | "unsupported_type" | "empty";

/** The file can't be uploaded at all — nothing was sent anywhere. */
export class BuildFileError extends Error {
  constructor(
    readonly code: BuildFileErrorCode,
    message: string,
    readonly filePath: string
  ) {
    super(message);
    this.name = "BuildFileError";
  }
}

export interface BuildFile {
  /** Absolute, with symlinks resolved — the file that will actually be read. */
  path: string;
  fileName: string;
  size: number;
  platform: BuildPlatform;
}

/**
 * Resolves and checks a build path without reading its contents. Relative
 * paths resolve against `cwd` (default: the process's working directory).
 * Symlinks are followed, so the size and type checked are those of the bytes
 * that will be uploaded, and the extension of the link's *target* counts —
 * `latest.apk -> notes.txt` is refused.
 */
export function inspectBuildFile(filePath: string, cwd = process.cwd()): BuildFile {
  const requested = path.resolve(cwd, filePath);
  let real: string;
  let stats: fs.Stats;
  try {
    real = fs.realpathSync(requested);
    stats = fs.statSync(real);
  } catch {
    throw new BuildFileError("not_found", `No such file: ${requested}`, requested);
  }
  if (!stats.isFile()) {
    throw new BuildFileError("not_a_file", `Not a file: ${requested}`, requested);
  }

  const extension = path.extname(real).toLowerCase();
  const platform = BUILD_EXTENSIONS[extension];
  if (!platform) {
    throw new BuildFileError(
      "unsupported_type",
      `Only .apk and .ipa builds can be uploaded (got ${extension || "no extension"}).`,
      requested
    );
  }
  if (stats.size === 0) {
    throw new BuildFileError("empty", `The file is empty: ${requested}`, requested);
  }
  return { path: real, fileName: path.basename(real), size: stats.size, platform };
}

/** App Dropper received the build but couldn't turn it into a release. */
export class BuildProcessingError extends Error {
  constructor(
    /** `invalid_build`, `upgrade_required`, or whatever the server reports. */
    readonly code: string,
    message: string,
    readonly uploadId: string
  ) {
    super(message);
    this.name = "BuildProcessingError";
  }
}

/** The bytes arrived but processing outlasted the wait. Nothing was lost. */
export class StillProcessingError extends Error {
  constructor(readonly uploadId: string) {
    super("The build is still processing. Check your dashboard in a moment — nothing was lost.");
    this.name = "StillProcessingError";
  }
}

/** Upload failed in transit, after the slot was reserved. The message is the
 *  underlying network or storage error, without a prefix. */
export class TransferError extends Error {
  constructor(
    message: string,
    readonly uploadId: string
  ) {
    super(message);
    this.name = "TransferError";
  }
}

export type UploadPhase = "reserving" | "uploading" | "processing";

/** A finished upload: every field the server sends for a `ready` build. */
export type ReadyUpload = UploadStatus & {
  status: "ready";
  build_id: string;
  install_url: string;
};

export interface UploadBuildOptions {
  client: AppDropperClient;
  /** Already checked by {@link inspectBuildFile}. */
  file: BuildFile;
  releaseNotes?: string;
  tag?: string;
  /** Pipeline identity, quoted in the notification email. CI only. */
  ci?: CiInfo;
  /** How long to wait for processing. Default 10 minutes. */
  timeoutMs?: number;
  signal?: AbortSignal;
  userAgent?: string;
  onPhase?: (phase: UploadPhase) => void;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
}

export const DEFAULT_PROCESS_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Uploads a checked build and waits for App Dropper to process it.
 *
 * Throws `ApiError` for anything the API refused (auth, plan limits, rate
 * limits), {@link TransferError} if the bytes didn't make it,
 * {@link BuildProcessingError} if the server rejected the binary,
 * {@link StillProcessingError} on timeout, and `AbortError` on cancellation.
 */
export async function uploadBuild(options: UploadBuildOptions): Promise<ReadyUpload> {
  const { client, file, signal } = options;

  // 1. Reserve the slot. Every plan limit, quota and rate limit is applied
  //    here, so a ticket coming back means the bytes are welcome.
  options.onPhase?.("reserving");
  const ticket = await client.createUpload({
    fileName: file.fileName,
    fileSize: file.size,
    releaseNotes: options.releaseNotes ?? "",
    tag: options.tag ?? "",
    ci: options.ci,
  });

  // 2. Send the binary straight to storage — it never passes through the API.
  options.onPhase?.("uploading");
  try {
    await uploadFile(
      ticket.upload_url,
      file.path,
      ticket.content_type,
      file.size,
      (sent) => options.onProgress?.(sent, file.size),
      { signal, userAgent: options.userAgent }
    );
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    throw new TransferError(err instanceof Error ? err.message : String(err), ticket.upload_id);
  }

  // 3. Wait for the server to parse it and mint the install link.
  options.onPhase?.("processing");
  const status = await client.awaitUpload(
    ticket.upload_id,
    options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS
  );

  if (status.status === "error") {
    throw new BuildProcessingError(
      status.error?.code ?? "invalid_build",
      status.error?.message ?? "This build could not be processed.",
      ticket.upload_id
    );
  }
  if (status.status !== "ready") throw new StillProcessingError(ticket.upload_id);
  return status as ReadyUpload;
}
