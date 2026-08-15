/**
 * A deliberately small flag parser. A CLI whose whole job is "run one command
 * in CI" shouldn't make every pipeline install an argument-parsing library
 * before it can upload a file.
 */

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    // `--` ends flag parsing, so a file called "--weird.apk" is still reachable.
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    const [name, inlineValue] = splitFlag(arg);
    if (inlineValue !== undefined) {
      flags[name] = inlineValue;
      continue;
    }
    const next = argv[i + 1];
    // A flag followed by another flag is a boolean switch, not a flag with a
    // value of "--json".
    if (next === undefined || next.startsWith("-")) {
      flags[name] = true;
    } else {
      flags[name] = next;
      i++;
    }
  }

  return { positionals, flags };
}

function splitFlag(arg: string): [string, string | undefined] {
  const body = arg.replace(/^-+/, "");
  const eq = body.indexOf("=");
  if (eq === -1) return [body, undefined];
  return [body.slice(0, eq), body.slice(eq + 1)];
}

/** Reads a flag under any of its accepted spellings. */
export function flag(
  args: ParsedArgs,
  names: string[],
  fallback?: string
): string | undefined {
  for (const name of names) {
    const value = args.flags[name];
    if (typeof value === "string") return value;
    // A valueless `--notes` is a mistake worth surfacing rather than silently
    // treating as an empty string.
    if (value === true) return "";
  }
  return fallback;
}

export function boolFlag(args: ParsedArgs, names: string[]): boolean {
  return names.some((name) => args.flags[name] === true || args.flags[name] === "true");
}
