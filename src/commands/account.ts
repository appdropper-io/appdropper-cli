import { boolFlag, flag, type ParsedArgs } from "../args";
import { AppDropperClient } from "../client";
import { apiUrl, loadCredential, resolveToken, saveCredential } from "../config";
import { CliError, EXIT } from "../errors";
import { asCliError } from "./upload";
import { color, info, out, success, warn } from "../ui";

function requireToken(args: ParsedArgs, base: string): string {
  const token = resolveToken(base, flag(args, ["token", "t"]));
  if (!token) {
    throw new CliError(
      "No API token. Set APPDROPPER_TOKEN, pass --token, or run `appdropper login`.",
      EXIT.AUTH
    );
  }
  return token;
}

/** Prints what the current token can do — the first thing to run when a
 *  pipeline is failing and nobody is sure which token it is using. */
export async function whoamiCommand(args: ParsedArgs): Promise<void> {
  const base = apiUrl();
  const token = requireToken(args, base);

  let identity;
  try {
    identity = await new AppDropperClient(base, token).whoami();
  } catch (err) {
    throw asCliError(err);
  }

  if (boolFlag(args, ["json"])) {
    out(JSON.stringify(identity, null, 2));
    return;
  }

  const source = flag(args, ["token", "t"])
    ? "--token"
    : process.env.APPDROPPER_TOKEN
      ? "APPDROPPER_TOKEN"
      : "saved login";

  info(`  ${color.dim("App")}     ${color.bold(identity.app_name)} ${color.dim(identity.bundle_id)}`);
  info(`  ${color.dim("Token")}   ${identity.token_name} ${color.dim(identity.hint)}`);
  info(`  ${color.dim("Scopes")}  ${identity.scopes.join(", ")}`);
  info(`  ${color.dim("Source")}  ${source}`);
  if (identity.expires_at) {
    const days = Math.ceil((identity.expires_at - Date.now()) / (24 * 60 * 60 * 1000));
    const when = new Date(identity.expires_at).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    if (days <= 7) warn(`This token expires in ${days} day${days === 1 ? "" : "s"} (${when}).`);
    else info(`  ${color.dim("Expires")} ${when}`);
  }
  info(`  ${color.dim("Link")}    ${color.cyan(identity.install_url)}`);
}

/**
 * Swaps the current token for a fresh one with the same name, app and validity
 * window. Reachable with nothing but the token itself, so a scheduled job can
 * keep its own credential alive; a saved login is updated in place.
 */
export async function rotateCommand(args: ParsedArgs): Promise<void> {
  const base = apiUrl();
  const token = requireToken(args, base);

  let rotated;
  try {
    rotated = await new AppDropperClient(base, token).rotate();
  } catch (err) {
    throw asCliError(err);
  }

  const saved = loadCredential(base);
  // Only rewrite the saved credential if that is the one that was just
  // rotated — otherwise rotating a CI token from a laptop would overwrite the
  // laptop's own login with a token for a different purpose.
  if (saved && saved.token === token) {
    saveCredential(base, {
      ...saved,
      token: rotated.token,
      hint: rotated.hint,
      expires_at: rotated.expires_at,
    });
    success("Rotated. Your saved login now uses the new token.");
    return;
  }

  if (boolFlag(args, ["json"])) {
    out(JSON.stringify(rotated, null, 2));
    return;
  }

  success("Rotated. The previous token stopped working immediately.");
  info();
  info(`  ${color.dim("New token")}  ${color.bold(rotated.token)}`);
  info(
    `  ${color.dim("Expires")}    ${new Date(rotated.expires_at).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    })}`
  );
  info();
  warn("Copy it now — this is the only time it is shown. Update your CI secret before the next build.");
  // stdout carries just the value, so `appdropper token rotate > secret.txt`
  // and `gh secret set APPDROPPER_TOKEN --body "$(appdropper token rotate)"`
  // both do the obvious thing.
  out(rotated.token);
}
