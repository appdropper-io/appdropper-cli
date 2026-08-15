import { boolFlag, flag, type ParsedArgs } from "../args";
import { AppDropperClient } from "../client";
import { apiUrl, resolveToken } from "../config";
import { CliError, EXIT } from "../errors";
import { asCliError } from "./upload";
import { color, formatBytes, info, out } from "../ui";

export async function buildsCommand(args: ParsedArgs): Promise<void> {
  const sub = args.positionals[0] ?? "list";
  if (sub !== "list") {
    throw new CliError(`Unknown builds command "${sub}". Try: appdropper builds list`, EXIT.USAGE);
  }

  const base = apiUrl();
  const token = resolveToken(base, flag(args, ["token", "t"]));
  if (!token) {
    throw new CliError(
      "No API token. Set APPDROPPER_TOKEN, pass --token, or run `appdropper login`.",
      EXIT.AUTH
    );
  }

  // "self" only resolves when the token covers exactly one app; with several
  // the server asks for an explicit ID rather than guessing. `appdropper
  // whoami` lists them.
  const appId = flag(args, ["app", "app-id", "appId"]) || "self";
  const limit = Math.min(100, Math.max(1, Number(flag(args, ["limit"]) ?? 20) || 20));

  let result;
  try {
    result = await new AppDropperClient(base, token).listBuilds(appId, limit);
  } catch (err) {
    throw asCliError(err);
  }

  if (boolFlag(args, ["json"])) {
    out(JSON.stringify(result, null, 2));
    return;
  }

  info(`${color.bold(result.app_name)} ${color.dim(result.bundle_id)}`);
  info();
  if (result.builds.length === 0) {
    info(color.dim("  No builds yet."));
    return;
  }

  for (const build of result.builds) {
    const version = `${build.version}${build.build_number ? ` (${build.build_number})` : ""}`;
    const expired = build.files_purged || (build.expires_at !== null && build.expires_at < Date.now());
    info(
      `  ${color.bold(version.padEnd(16))} ${build.platform.padEnd(8)} ${formatBytes(
        build.file_size
      ).padStart(9)}  ${
        expired ? color.dim("expired") : color.green("live   ")
      }  ${color.dim(`${build.install_count} install${build.install_count === 1 ? "" : "s"}`)}`
    );
    info(`  ${color.dim(build.install_url)}`);
    info();
  }
}
