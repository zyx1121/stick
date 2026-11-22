# tmux

Claude Code and Codex plugin: a Bun MCP server (`src/`, bundled to `dist/server.js`) that runs `tmux` on this machine, or on another host through `ssh`. Read [README.md](README.md) first.

## Rules

- Every remote call is `ssh -o BatchMode=yes <host> -- <quoted tmux argv>`. Quote each word with `shellQuote`. Never build a remote command by joining unquoted strings.
- A `host` must match `HOST_PATTERN`, so it can never become an ssh option.
- Text typed into a pane goes through `load-buffer` from stdin and `paste-buffer -p`, never through `send-keys -l`. Shell plugins that auto-pair braces would change typed keys.
- `tmux_run` only types at a shell prompt. A pane that runs another program answers `busy`.
- A failure returns the error envelope with a `code` and a `hint`. A tool never throws to the MCP client.
- No host names, users or addresses in code. Hosts come from the caller and the user's `~/.ssh/config`.
- `plugin.json` and `mcp.json` are the manifest sources. Do not hand-edit the generated `.claude-plugin/plugin.json`, `.mcp.json` or `dist/server.js`.
- Repository documents and code comments are English.

## Where to run things

In Loki's environment, the MacBook is for editing and git only. Run `bun install`, the build and the tests on `ssh sandbox` in a login shell (`bash -lc`). The live tests start a private tmux server on its own socket (`tmux -L`), so they never touch a real session.

## Verify

```sh
bun install --frozen-lockfile
bun run check
```

Build with the Bun version that CI uses (`bun-version` in `.github/workflows/check.yml`). Another version produces a different `dist/server.js`, and the CI diff step fails.

For a live check, call `tmux_new` with a `host`, then `tmux_run` with `echo ok`, then `tmux_kill`.

## Release

1. Bump `version` in `package.json` and `plugin.json`, run `bun run check`, and commit the regenerated files.
2. Merge the PR. Then pin the new commit in [zyx1121/marketplace](https://github.com/zyx1121/marketplace) (see its AGENTS.md).
