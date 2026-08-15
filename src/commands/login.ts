import { spawn } from "child_process";
import { boolFlag, type ParsedArgs } from "../args";
import { AppDropperClient } from "../client";
import { apiUrl, clearCredential, configPath, loadCredential, saveCredential } from "../config";
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
export async function loginCommand(args: ParsedArgs): Promise<void> {
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

    saveCredential(base, {
      token: granted.access_token,
      app_id: granted.app_id,
      app_name: granted.app_name,
      hint: granted.hint,
      expires_at: granted.expires_at,
    });

    info();
    success(`Signed in. This machine can now upload builds of ${color.bold(granted.app_name)}.`);
    info(`  ${color.dim("Token saved to")} ${configPath()} ${color.dim("(chmod 600)")}`);
    info(
      `  ${color.dim("Expires")}        ${new Date(granted.expires_at).toLocaleDateString(
        undefined,
        { day: "numeric", month: "short", year: "numeric" }
      )}`
    );
    info();
    info(color.dim("Next: appdropper upload path/to/build.apk"));
    return;
  }
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
    `Removed the saved token for ${existing.app_name || base}. It stays valid until you revoke it in the dashboard.`
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
