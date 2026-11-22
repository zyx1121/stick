# stick

Claude Code and Codex plugin: a Bun MCP server (`src/`, bundled to `dist/server.js`) that runs commands on this machine or any ssh host, Linux or Windows, drives tmux, and uses a Windows desktop through a small daemon (`windows/`). Read [README.md](README.md) first.

## Layout

- `src/host/`: OS detection, `exec` for posix and Windows, the ssh config reader.
- `src/tmux/`: tmux over ssh, with the run markers and the paste.
- `src/desktop/`: the client of the desktop daemon (tunnel, token, file download).
- `windows/`: the daemon source (`fwd.cs`) and its installer. `desktop_install` ships both from the bundle.

## Rules

- A command never travels in the ssh argv. Posix scripts go on stdin to `POSIX_RUNNER`, which saves them to a temp file in a per-user 0700 folder (`stick-<uid>` under `$TMPDIR` or `/tmp`; on Windows `%TEMP%\stick`), removed on normal exit and swept after one day when a timeout kills the runner, and runs them with stdin on `/dev/null`, so a command that reads stdin cannot eat the next lines. Windows scripts go on stdin as base64 lines to the fixed PowerShell wrapper in `src/host/exec.ts`, which is sent as `-EncodedCommand`. Keep the wrapper ASCII and under cmd's 8191 character limit. The script itself runs in a child PowerShell whose stdin is an empty file, so native programs never wait on the ssh stdin.
- Windows OpenSSH does not pass end of input to the program. The wrapper stops reading at a line holding `.`. Do not switch it to `ReadToEnd`.
- tmux arguments go through `shellQuote`. Text typed into a pane goes through `load-buffer` and `paste-buffer -p`, never through `send-keys -l`.
- A `host` must match `HOST_PATTERN`, so it can never become an ssh option.
- tmux tools refuse Windows hosts and desktop tools refuse posix hosts with `unsupported_os`.
- A failure returns the error envelope with a `code` and a `hint`. A tool never throws to the MCP client.
- No host names, users or addresses in code. Hosts come from the caller and the user's `~/.ssh/config`.
- `plugin.json` and `mcp.json` are the manifest sources. Do not hand-edit the generated `.claude-plugin/plugin.json`, `.mcp.json` or `dist/server.js`.
- Repository documents and code comments are English.

## Where to run things

In Loki's environment, the MacBook is for editing and git only. Run `bun install`, the build and the tests on `ssh sandbox` in a login shell (`bash -lc`). The tests run bash and a private tmux server (`tmux -L`). Nothing in CI reaches a Windows machine, so check Windows changes by hand (see Verify).

## Verify

```sh
bun install --frozen-lockfile
bun run check
```

Build with the Bun version that CI uses (`bun-version` in `.github/workflows/check.yml`). Another version produces a different `dist/server.js`, and the CI diff step fails.

For a live check on a Windows host: `hosts` with the host (expect `windows`), `exec` with a script that prints non-ASCII text, a quoted path and `exit 7`, then `desktop` with `status`.

## Release

1. Bump `version` in `package.json` and `plugin.json`, run `bun run check`, and commit the regenerated files.
2. Merge the PR. Then pin the new commit in [zyx1121/marketplace](https://github.com/zyx1121/marketplace) (see its AGENTS.md).
