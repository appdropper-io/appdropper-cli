import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Credentials written by `appdropper login`. CI never reads this file — it
 * passes a token through the environment — so this exists purely for the
 * human-at-a-laptop case.
 */

export const DEFAULT_API_URL = "https://appdropper.io/api/v1";

export interface StoredCredential {
  token: string;
  /** Every app the token covers — one login can now grant several. */
  app_ids: string[];
  app_names: string[];
  hint: string;
  expires_at: number;
}

interface ConfigFile {
  /**
   * Keyed by API base URL, so signing in against a staging deployment doesn't
   * silently replace the credential for production.
   */
  credentials: Record<string, StoredCredential>;
}

export function configDir(): string {
  return process.env.APPDROPPER_CONFIG_DIR ?? path.join(os.homedir(), ".appdropper");
}

export function configPath(): string {
  return path.join(configDir(), "config");
}

export function apiUrl(): string {
  return (process.env.APPDROPPER_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, "");
}

function read(): ConfigFile {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<ConfigFile>;
    return { credentials: parsed.credentials ?? {} };
  } catch {
    // Missing, unreadable, or corrupt all mean the same thing to the caller:
    // there is no saved login. A parse failure shouldn't wedge the CLI when
    // `login` can simply rewrite the file.
    return { credentials: {} };
  }
}

function write(config: ConfigFile): void {
  const dir = configDir();
  // 0700 so the directory listing itself is private, matching what ssh and gh
  // do with theirs.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = configPath();
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // mkdir/writeFile honour `mode` only when they create the file, so an
  // existing config keeps whatever permissions it already had — re-apply them
  // explicitly rather than trusting the first write.
  fs.chmodSync(file, 0o600);
}

export function saveCredential(base: string, credential: StoredCredential): void {
  const config = read();
  config.credentials[base] = credential;
  write(config);
}

export function loadCredential(base: string): StoredCredential | null {
  return read().credentials[base] ?? null;
}

export function clearCredential(base: string): boolean {
  const config = read();
  if (!config.credentials[base]) return false;
  delete config.credentials[base];
  write(config);
  return true;
}

/**
 * Where a token comes from, in order of how explicit it is: an argument beats
 * the environment, and the environment beats a saved login. CI sets
 * APPDROPPER_TOKEN and never has a saved login at all.
 */
export function resolveToken(base: string, explicit?: string): string | null {
  if (explicit) return explicit;
  if (process.env.APPDROPPER_TOKEN) return process.env.APPDROPPER_TOKEN;
  return loadCredential(base)?.token ?? null;
}
