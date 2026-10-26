import { spawn } from "child_process";
import { boolFlag, type ParsedArgs } from "../args";
import { AppDropperClient } from "../client";
import { isCi } from "../ci";
import {
  apiUrl,
  clearCredential,
  configPath,
  loadCredential,
  resolveToken,
  saveCredential,
} from "../config";
import { CliError, EXIT } from "../errors";
import { asCliError } from "./upload";
import { color, info, success } from "../ui";

/**
 * Device-authorization login, the same shape as `gh auth login`: the CLI shows
 * a short code, the human approves it in a browser they already trust, and the
 * CLI collects the resulting token. No password is ever typed into a terminal,
 * and nothing here works without a browser — which is exactly why CI uses a
 * pre-generated token in APPDROPPER_TOKEN instead.
 */
export async function loginCommand(
  args: ParsedArgs,
  { continuing = false }: { continuing?: boolean } = {}
): Promise<void> {
  const base = apiUrl();
  const client = new AppDropperClient(base);

  if (process.env.APPDROPPER_TOKEN) {
    info(
      color.dim(
        "Note: APPDROPPER_TOKEN is set in this shell and takes priority over a saved login."
      )
    );
  }

  let start;
  try {
    start = await client.startDeviceAuth("App Dropper CLI");
  } catch (err) {
    throw asCliError(err);
  }

  info();
  info(`  ${color.dim("Your code")}  ${color.bold(color.violet(start.user_code))}`);
  info(`  ${color.dim("Open")}       ${color.cyan(start.verification_uri_complete)}`);
  info();

  if (!boolFlag(args, ["no-browser", "noBrowser"])) openBrowser(start.verification_uri_complete);
  info("Waiting for you to approve it in the browser…");

  const deadline = Date.now() + start.expires_in * 1000;
  let interval = start.interval * 1000;

  for (;;) {
    if (Date.now() > deadline) {
      throw new CliError("That code expired before it was approved. Try again.", EXIT.AUTH);
    }
    await sleep(interval);

    let granted;
    try {
      granted = await client.pollDeviceAuth(start.device_code);
    } catch (err) {
      const cli = asCliError(err);
      // `slow_down` is handled inside the client; anything else that survives
      // to here is terminal — a denial, or an expired code.
      throw cli;
    }
    if (!granted) {
      // Back off gently in case the server asked us to slow down.
      interval = Math.min(interval + 1000, 15_000);
      continue;
    }

    const appNames = granted.app_names ?? [];
    saveCredential(base, {
      token: granted.access_token,
      app_ids: granted.app_ids ?? [],
      app_names: appNames,
      all_apps: granted.all_apps === true,
      hint: granted.hint,
      expires_at: granted.expires_at,
    });

    info();
    success(
      `Signed in. This machine can now upload builds to ${color.bold(
        granted.all_apps
          ? "all your apps, including new ones"
          : appNames.length
            ? appNames.join(", ")
            : "your apps"
      )}.`
    );
    info(`  ${color.dim("Token saved to")} ${configPath()} ${color.dim("(chmod 600)")}`);
    info(
      `  ${color.dim("Expires")}        ${new Date(granted.expires_at).toLocaleDateString(
        undefined,
        { day: "numeric", month: "short", year: "numeric" }
      )}`
    );
    info();
    if (!continuing) info(color.dim("Next: appdropper upload path/to/build.apk"));
    return;
  }
}

/**
 * The token for a command that needs one. A person at a terminal with no login
 * yet is signed in on the spot, so their first `upload` or `flutter build`
 * still finishes in one go. CI, or anything else nobody is watching, fails
 * fast instead: there is no one to approve a browser prompt.
 */
export async function requireToken(explicit: string | undefined, args: ParsedArgs): Promise<string> {
  const base = apiUrl();
  const existing = resolveToken(base, explicit);
  if (existing) return existing;

  if (!canSignInHere()) {
    throw new CliError(
      "No API token. Set APPDROPPER_TOKEN, pass --token, or run `appdropper login`.",
      EXIT.AUTH
    );
  }

  info(color.dim("Not logged in on this machine yet. Sign in once and the command carries on."));
  await loginCommand(args, { continuing: true });
  const token = resolveToken(base);
  if (!token) throw new CliError("Sign-in didn't complete. Run `appdropper login`.", EXIT.AUTH);
  return token;
}

function canSignInHere(): boolean {
  return process.stdin.isTTY === true && process.stderr.isTTY === true && !isCi();
}

export async function logoutCommand(): Promise<void> {
  const base = apiUrl();
  const existing = loadCredential(base);
  if (!existing) {
    info("No saved login to remove.");
    return;
  }
  clearCredential(base);
  success(
    `Removed the saved token for ${
      existing.app_names?.length ? existing.app_names.join(", ") : base
    }. It stays valid until you revoke it in the dashboard.`
  );
}

/**
 * Best-effort — a headless box has no browser, and the code is already
 * printed, so a failure here isn't worth mentioning.
 */
function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(command, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Ignored on purpose.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
