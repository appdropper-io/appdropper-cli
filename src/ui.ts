import * as qr from "qrcode-terminal";

/**
 * Terminal output helpers.
 *
 * Everything here writes to stderr except `out`, so that piping the CLI's
 * stdout somewhere useful (`--json`, an install URL into another command)
 * doesn't drag progress bars and banners along with it.
 */

/**
 * CI logs are not terminals and mangle escape codes into noise, so colour is
 * opt-out via NO_COLOR and off by default anywhere that isn't a TTY — except
 * on the CI providers that do render them, which announce themselves.
 */
const useColor =
  !process.env.NO_COLOR &&
  (process.stderr.isTTY === true ||
    process.env.GITHUB_ACTIONS === "true" ||
    process.env.CI === "true");

const wrap = (code: string) => (text: string) =>
  useColor ? `\u001b[${code}m${text}\u001b[0m` : text;

export const color = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  violet: wrap("35"),
  cyan: wrap("36"),
};

/** The result of the command — the only thing on stdout. */
export function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

export function info(line = ""): void {
  process.stderr.write(`${line}\n`);
}

export function success(line: string): void {
  info(`${color.green("✓")} ${line}`);
}

export function warn(line: string): void {
  info(`${color.yellow("!")} ${line}`);
}

export function error(line: string): void {
  info(`${color.red("✗")} ${line}`);
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * A progress bar on a TTY, periodic one-line updates everywhere else.
 *
 * The distinction matters more than it looks: a carriage-return bar written to
 * a CI log produces thousands of lines of half-drawn bars, which is why so many
 * upload tools are unreadable in Actions output.
 */
export function progressBar(label: string, total: number) {
  const interactive = process.stderr.isTTY === true;
  const started = Date.now();
  let lastDrawn = 0;
  let finished = false;

  const draw = (transferred: number, force = false) => {
    if (finished) return;
    const now = Date.now();
    // A TTY can repaint freely; a log file gets a line every 5 seconds.
    const interval = interactive ? 100 : 5000;
    if (!force && now - lastDrawn < interval) return;
    lastDrawn = now;

    const ratio = total > 0 ? Math.min(1, transferred / total) : 0;
    const percent = Math.round(ratio * 100);
    const elapsed = (now - started) / 1000;
    const rate = elapsed > 0 ? transferred / elapsed : 0;
    const eta = rate > 0 ? (total - transferred) / rate : Infinity;

    if (!interactive) {
      info(
        `${label} ${percent}% (${formatBytes(transferred)} / ${formatBytes(total)}) at ${formatBytes(
          rate
        )}/s`
      );
      return;
    }

    const width = 28;
    const filled = Math.round(ratio * width);
    const bar = `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
    process.stderr.write(
      `\r  ${color.violet(bar)} ${String(percent).padStart(3)}%  ${formatBytes(
        transferred
      )} / ${formatBytes(total)}  ${formatBytes(rate)}/s  ETA ${formatDuration(eta)}   `
    );
  };

  return {
    update: (transferred: number) => draw(transferred),
    done: () => {
      if (finished) return;
      draw(total, true);
      finished = true;
      if (interactive) process.stderr.write("\n");
    },
  };
}

/** Braille spinner for the phase where there is nothing to measure. */
export function spinner(label: string) {
  if (process.stderr.isTTY !== true) {
    info(`${label}…`);
    return { stop: () => {} };
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const timer = setInterval(() => {
    process.stderr.write(`\r  ${color.violet(frames[i++ % frames.length])} ${label}   `);
  }, 80);
  // Nothing else is scheduled while we wait on the network, and an active
  // interval would otherwise be reason enough for Node to stay alive.
  timer.unref?.();
  return {
    stop: () => {
      clearInterval(timer);
      process.stderr.write(`\r${" ".repeat(label.length + 8)}\r`);
    },
  };
}

/** ASCII QR so a phone can install the build straight off the terminal. */
export function printQr(url: string): void {
  qr.generate(url, { small: true }, (rendered: string) => {
    info(rendered.replace(/\n$/, ""));
  });
}
