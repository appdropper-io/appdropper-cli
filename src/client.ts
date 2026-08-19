import * as fs from "fs";
import * as https from "https";
import * as http from "http";
import { URL } from "url";
import type { CiInfo } from "./ci";

/**
 * Everything the CLI knows how to say to App Dropper. Built on node:https
 * directly rather than a fetch wrapper or an SDK: `npx appdropper` should
 * install in a second inside a CI job, and every dependency here is one the
 * user waits for on every single build.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

interface RequestOptions {
  method: "GET" | "POST" | "PUT";
  url: string;
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Milliseconds of inactivity before giving up. */
  timeoutMs?: number;
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(options: RequestOptions): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(options.url);
    const transport = url.protocol === "http:" ? http : https;
    const payload = options.body === undefined ? null : JSON.stringify(options.body);

    const req = transport.request(
      {
        method: options.method,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        headers: {
          accept: "application/json",
          "user-agent": userAgent(),
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          ...(payload
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              }
            : {}),
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );

    req.setTimeout(options.timeoutMs ?? 60_000, () => {
      req.destroy(new Error("The request timed out."));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export function userAgent(): string {
  return `appdropper-cli/${
    // Read lazily so a broken package.json can't stop the CLI from running.
    (() => {
      try {
        return require("../package.json").version as string;
      } catch {
        return "0.0.0";
      }
    })()
  } node/${process.versions.node}`;
}

/** Parses the API's `{ error: { code, message } }` envelope. */
function parse(res: RawResponse): unknown {
  let parsed: unknown = null;
  try {
    parsed = res.body ? JSON.parse(res.body) : null;
  } catch {
    // A non-JSON body from a 5xx is usually a proxy error page; the status is
    // the only trustworthy part of it.
  }
  if (res.status >= 400) {
    const envelope = (parsed as { error?: { code?: string; message?: string } })?.error;
    throw new ApiError(
      res.status,
      envelope?.code ?? "http_error",
      envelope?.message ?? `Request failed with HTTP ${res.status}.`
    );
  }
  return parsed;
}

export interface UploadTicket {
  upload_id: string;
  upload_url: string;
  content_type: string;
  app_id: string;
  app_name: string;
}

export interface UploadStatus {
  upload_id: string;
  status: "pending" | "processing" | "ready" | "error";
  error?: { code: string; message: string };
  build_id?: string;
  app_id?: string;
  app_name?: string;
  version?: string;
  build_number?: string;
  bundle_id?: string;
  platform?: string;
  install_url?: string;
  qr_url?: string;
  expires_at?: number;
}

export interface TokenApp {
  app_id: string;
  app_name: string;
  bundle_id: string;
  install_url: string;
}

export interface TokenIdentity {
  token_id: string;
  token_name: string;
  hint: string;
  scopes: string[];
  expires_at: number | null;
  /** Every app this token may upload to. */
  apps: TokenApp[];
}

export interface BuildSummary {
  build_id: string;
  version: string;
  build_number: string;
  platform: string;
  tag: string;
  file_size: number;
  status: string;
  install_count: number;
  uploaded_at: number | null;
  expires_at: number | null;
  files_purged: boolean;
  install_url: string;
}

export class AppDropperClient {
  constructor(
    private readonly base: string,
    private readonly token?: string
  ) {}

  private url(path: string): string {
    return `${this.base}${path}`;
  }

  async createUpload(input: {
    fileName: string;
    fileSize: number;
    releaseNotes?: string;
    tag?: string;
    /** Pipeline that produced the build; quoted in the notification email. */
    ci?: CiInfo;
  }): Promise<UploadTicket> {
    return parse(
      await request({
        method: "POST",
        url: this.url("/uploads"),
        token: this.token,
        body: {
          file_name: input.fileName,
          file_size: input.fileSize,
          release_notes: input.releaseNotes ?? "",
          tag: input.tag ?? "",
          ...(input.ci ? { ci: input.ci } : {}),
        },
      })
    ) as UploadTicket;
  }

  /**
   * Waits for parsing to finish. The server holds the connection for up to
   * `waitSeconds`, so this is one request in the common case rather than a
   * client-side poll loop; the loop below only exists for builds that take
   * longer than a single hold.
   */
  async awaitUpload(uploadId: string, timeoutMs: number): Promise<UploadStatus> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = Math.max(0, deadline - Date.now());
      const wait = Math.min(120, Math.floor(remaining / 1000));
      const status = parse(
        await request({
          method: "GET",
          url: this.url(`/uploads/${encodeURIComponent(uploadId)}?wait=${wait}`),
          token: this.token,
          // Generously past the server's own hold, so the client isn't the one
          // that gives up on a request the server is still honouring.
          timeoutMs: (wait + 30) * 1000,
        })
      ) as UploadStatus;
      if (status.status === "ready" || status.status === "error") return status;
      if (Date.now() >= deadline) return status;
    }
  }

  async whoami(): Promise<TokenIdentity> {
    return parse(
      await request({ method: "GET", url: this.url("/me"), token: this.token })
    ) as TokenIdentity;
  }

  async listBuilds(appId: string, limit: number) {
    return parse(
      await request({
        method: "GET",
        url: this.url(`/apps/${encodeURIComponent(appId)}/builds?limit=${limit}`),
        token: this.token,
      })
    ) as { app_name: string; bundle_id: string; builds: BuildSummary[] };
  }

  async rotate() {
    return parse(
      await request({ method: "POST", url: this.url("/tokens/rotate"), token: this.token })
    ) as { token: string; token_id: string; hint: string; expires_at: number };
  }

  async startDeviceAuth(clientName: string) {
    return parse(
      await request({
        method: "POST",
        url: this.url("/device/code"),
        body: { client_name: clientName },
      })
    ) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      verification_uri_complete: string;
      expires_in: number;
      interval: number;
    };
  }

  /**
   * One poll of the device flow. Returns null while the user hasn't answered
   * yet — `authorization_pending` and `slow_down` are the expected steady
   * state of this endpoint, not failures.
   */
  async pollDeviceAuth(deviceCode: string): Promise<{
    access_token: string;
    token_id: string;
    hint: string;
    app_ids: string[];
    app_names: string[];
    expires_at: number;
  } | null> {
    try {
      return parse(
        await request({
          method: "POST",
          url: this.url("/device/token"),
          body: { device_code: deviceCode },
        })
      ) as {
        access_token: string;
        token_id: string;
        hint: string;
        app_ids: string[];
        app_names: string[];
        expires_at: number;
      };
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.code === "authorization_pending" || err.code === "slow_down")
      ) {
        return null;
      }
      throw err;
    }
  }
}

// ------------------------------------------------------------ binary upload

/** How many times a dropped connection is resumed before giving up. */
const UPLOAD_ATTEMPTS = 4;

/**
 * Sends the binary to the Google Cloud Storage resumable session the API
 * handed out.
 *
 * Resumable is the point: a 500 MB upload from a CI runner on a bad network
 * will occasionally drop, and restarting from zero can cost more than the
 * build did. On a failure this asks the session how many bytes it actually
 * received and continues from there, so a retry pays only for what was lost.
 */
export async function uploadFile(
  sessionUrl: string,
  filePath: string,
  contentType: string,
  totalSize: number,
  onProgress: (transferred: number) => void
): Promise<void> {
  let offset = 0;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    try {
      await sendChunk(sessionUrl, filePath, contentType, totalSize, offset, onProgress);
      return;
    } catch (err) {
      lastError = err as Error;
      if (attempt === UPLOAD_ATTEMPTS) break;
      // Ask the session what it kept. A session that has gone away answers 404
      // or 410, and there is nothing to resume from — fail rather than loop.
      const received = await queryOffset(sessionUrl, totalSize);
      if (received === null) break;
      offset = received;
      onProgress(offset);
      await delay(Math.min(8000, 500 * 2 ** attempt));
    }
  }

  throw lastError ?? new Error("The upload failed.");
}

function sendChunk(
  sessionUrl: string,
  filePath: string,
  contentType: string,
  totalSize: number,
  offset: number,
  onProgress: (transferred: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(sessionUrl);
    const transport = url.protocol === "http:" ? http : https;
    const remaining = totalSize - offset;

    const req = transport.request(
      {
        method: "PUT",
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        headers: {
          "content-type": contentType,
          "content-length": remaining,
          "user-agent": userAgent(),
          // Only sent when resuming: on a first, whole-file PUT, Content-Range
          // is unnecessary and some proxies handle its absence better.
          ...(offset > 0
            ? { "content-range": `bytes ${offset}-${totalSize - 1}/${totalSize}` }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            resolve();
            return;
          }
          reject(
            new Error(
              `Storage rejected the upload (HTTP ${status}). ${Buffer.concat(chunks)
                .toString("utf8")
                .slice(0, 300)}`
            )
          );
        });
      }
    );

    // No overall timeout: a large upload legitimately takes minutes. The idle
    // timeout below is what catches a genuinely dead connection.
    req.setTimeout(120_000, () => req.destroy(new Error("The upload stalled.")));
    req.on("error", reject);

    let sent = offset;
    const stream = fs.createReadStream(filePath, { start: offset });
    stream.on("data", (chunk) => {
      sent += chunk.length;
      onProgress(sent);
    });
    stream.on("error", (err) => {
      req.destroy();
      reject(err);
    });
    stream.pipe(req);
  });
}

/** Bytes the session has already stored, or null if it is no longer usable. */
async function queryOffset(sessionUrl: string, totalSize: number): Promise<number | null> {
  try {
    const res = await request({
      method: "PUT",
      url: sessionUrl,
      headers: { "content-range": `bytes */${totalSize}`, "content-length": "0" },
      timeoutMs: 30_000,
    });
    // 200/201 means GCS considers the object complete already.
    if (res.status === 200 || res.status === 201) return totalSize;
    // 308 "Resume Incomplete" carries the stored range; no Range header at all
    // means it has nothing yet.
    if (res.status === 308) {
      const range = String(res.headers.range ?? "");
      const match = range.match(/bytes=0-(\d+)/);
      return match ? Number(match[1]) + 1 : 0;
    }
    return null;
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
