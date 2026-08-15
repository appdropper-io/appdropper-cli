#!/usr/bin/env node
import { boolFlag, parseArgs } from "./args";
import { CliError, EXIT } from "./errors";
import { uploadCommand } from "./commands/upload";
import { loginCommand, logoutCommand } from "./commands/login";
import { buildsCommand } from "./commands/builds";
import { rotateCommand, whoamiCommand } from "./commands/account";
import { apiUrl } from "./config";
import { color, error, info } from "./ui";

const VERSION: string = (() => {
  try {
    return require("../package.json").version as string;
  } catch {
    return "0.0.0";
  }
})();

const HELP = `
${color.violet("App Dropper")} — ship .apk and .ipa builds from your terminal or CI.

${color.bold("USAGE")}
  appdropper <command> [options]

${color.bold("COMMANDS")}
  upload <file>        Upload a build and print its install link
  builds list          Recent builds (--app <id> if the token covers several)
  login                Authorize this machine in a browser
  logout               Forget the saved login on this machine
  whoami               Show which apps and token are in use
  token rotate         Replace the current token with a fresh one

${color.bold("UPLOAD OPTIONS")}
  --token <value>      API token (default: $APPDROPPER_TOKEN, then saved login)
  --notes <text>       Release notes shown to testers on the install page
  --tag <name>         Label for the build, e.g. "beta" or "nightly"
  --timeout <seconds>  How long to wait for processing (default 600)
  --json               Print the full result as JSON instead of a summary
  --no-qr              Skip the terminal QR code

${color.bold("EXAMPLES")}
  appdropper upload build/app/outputs/flutter-apk/app-release.apk
  appdropper upload MyApp.ipa --notes "$(git log -1 --pretty=%B)"
  appdropper upload app.apk --token $APPDROPPER_TOKEN --json

${color.bold("EXIT CODES")}
  0 success · 1 failed · 2 bad usage · 3 auth problem · 4 rate limited

${color.bold("ENVIRONMENT")}
  APPDROPPER_TOKEN     Token to use — how CI authenticates
  APPDROPPER_API_URL   API base URL (default ${apiUrl()})
  NO_COLOR             Disable coloured output

Docs: https://appdropper.io/help/ci-cd-uploads
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const command = args.positionals.shift();

  if (boolFlag(args, ["version", "v"]) || command === "version") {
    info(VERSION);
    return EXIT.OK;
  }
  if (!command || boolFlag(args, ["help", "h"]) || command === "help") {
    info(HELP.trim());
    return command || boolFlag(args, ["help", "h"]) ? EXIT.OK : EXIT.USAGE;
  }

  switch (command) {
    case "upload":
      await uploadCommand(args);
      return EXIT.OK;
    case "builds":
      await buildsCommand(args);
      return EXIT.OK;
    case "login":
      await loginCommand(args);
      return EXIT.OK;
    case "logout":
      await logoutCommand();
      return EXIT.OK;
    case "whoami":
      await whoamiCommand(args);
      return EXIT.OK;
    case "token":
      // `token rotate` is the only subcommand; anything else is a typo worth
      // naming rather than silently rotating a credential.
      if (args.positionals[0] !== "rotate") {
        throw new CliError("Usage: appdropper token rotate", EXIT.USAGE);
      }
      args.positionals.shift();
      await rotateCommand(args);
      return EXIT.OK;
    default:
      throw new CliError(
        `Unknown command "${command}". Run \`appdropper --help\` to see what's available.`,
        EXIT.USAGE
      );
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (err instanceof CliError) {
      error(err.message);
      process.exitCode = err.exitCode;
      return;
    }
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = EXIT.FAILURE;
  });
