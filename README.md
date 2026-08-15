# appdropper

Upload `.apk` and `.ipa` builds to [App Dropper](https://appdropper.io) from your terminal or CI pipeline, and get a shareable install link back.

```bash
npx appdropper upload build/app-release.apk
```

```
✓ Acme Mobile 2.4.1 (318) is live

  █▀▀▀▀▀█ ▀▄█▀▄ █▀▀▀▀▀█
  █ ███ █ ▀█ ▄▄ █ ███ █
  █ ▀▀▀ █ █▄▀█▀ █ ▀▀▀ █
  ▀▀▀▀▀▀▀ █ ▀ █ ▀▀▀▀▀▀▀

  Install link  https://appdropper.io/acme-mobile?build=aBc123XyZ
  Expires       Sat, 15 Nov 2026 00:00:00 GMT
```

## Install

You don't have to — `npx` runs it in one step, which is what the CI examples use. For repeated local use:

```bash
npm install -g appdropper
```

Requires Node 18+.

## Authenticate

Generate a token under **Settings → API tokens** in your App Dropper dashboard. Each token is scoped to a single app and carries one scope, `upload:builds` — it cannot delete builds, manage testers, read billing, or reach another app.

In CI, put it in your provider's secret store as `APPDROPPER_TOKEN`:

```bash
export APPDROPPER_TOKEN="adp_…"
appdropper upload build.apk
```

On your own machine you can log in through the browser instead — no password is ever typed into the terminal, and the token lands in `~/.appdropper/config` with `chmod 600`:

```bash
appdropper login
```

## Commands

| Command | What it does |
|---|---|
| `appdropper upload <file>` | Upload a build, wait for processing, print the install link |
| `appdropper builds list` | Recent builds for this token's app |
| `appdropper login` | Authorize this machine in a browser |
| `appdropper logout` | Forget the saved login |
| `appdropper whoami` | Show which app and token are in use |
| `appdropper token rotate` | Replace the current token with a fresh one |

### Upload flags

| Flag | Default | Purpose |
|---|---|---|
| `--token <value>` | `$APPDROPPER_TOKEN` | Token to authenticate with |
| `--notes <text>` | empty | Release notes shown to testers |
| `--tag <name>` | `beta` | Build label. `--group` is an alias |
| `--timeout <seconds>` | `600` | How long to wait for processing |
| `--json` | off | Print the full result as JSON |
| `--no-qr` | off | Skip the terminal QR code |

## Exit codes

A pipeline can tell a retryable failure from a permanent one:

| Code | Meaning | Retry? |
|---|---|---|
| `0` | Success | — |
| `1` | The upload or request failed | Usually worth one retry |
| `2` | Bad arguments | No |
| `3` | Missing, expired, revoked or out-of-scope token | No — fix the credential |
| `4` | Rate limited | Yes, after the stated wait |

## Output

The install URL — and only the install URL — goes to stdout. Progress bars and status messages go to stderr, so pipes stay clean:

```bash
URL=$(appdropper upload build.apk)
```

Inside GitHub Actions the CLI also writes `install-url`, `build-id` and `qr-url` to `$GITHUB_OUTPUT`, so a plain `run:` step gets step outputs without the wrapper action.

## Environment

| Variable | Purpose |
|---|---|
| `APPDROPPER_TOKEN` | Token to use — how CI authenticates |
| `APPDROPPER_API_URL` | API base URL (default `https://appdropper.io/api/v1`) |
| `APPDROPPER_CONFIG_DIR` | Where the saved login lives (default `~/.appdropper`) |
| `NO_COLOR` | Disable coloured output |

## How an upload works

Three requests, hidden behind one command:

1. **Reserve** — the CLI declares the file name and size. Every plan limit, storage quota and rate limit is applied before a byte moves, and the API returns a resumable upload URL.
2. **Transfer** — the binary goes straight from your machine to Google Cloud Storage, never through the API. That's why build size is capped only by your plan. A dropped connection resumes from where it stopped rather than starting over.
3. **Wait** — a long poll while the server unpacks the binary, reads its name, icon, version and bundle ID, files it as a build, and notifies your testers.

## Docs

- [CI/CD setup guide](https://appdropper.io/help/ci-cd-uploads)
- [CLI reference](https://appdropper.io/help/cli)
- [REST API reference](https://appdropper.io/help/api)

## License

MIT
