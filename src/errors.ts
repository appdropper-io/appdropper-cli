/**
 * Exit codes are part of the CLI's contract: a pipeline needs to tell "the
 * network blipped, retry" apart from "this token is dead, stop retrying".
 */
export const EXIT = {
  OK: 0,
  /** The upload or request failed. */
  FAILURE: 1,
  /** Bad arguments — retrying won't help. */
  USAGE: 2,
  /** Missing, expired, revoked or out-of-scope token. */
  AUTH: 3,
  /** Rate limited; the message says how long to wait. */
  RATE_LIMITED: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode = EXIT.FAILURE
  ) {
    super(message);
  }
}
