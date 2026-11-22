<div align="center">

<h1>tmux</h1>

<p><strong>Run commands in tmux on any SSH host from your agent, and get back the output and the exit code.</strong></p>

[![CI](https://img.shields.io/github/actions/workflow/status/zyx1121/tmux/check.yml?branch=main&style=flat-square&label=CI)](https://github.com/zyx1121/tmux/actions)
[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-D97757?style=flat-square)](https://github.com/zyx1121/marketplace)
[![License](https://img.shields.io/github/license/zyx1121/tmux?style=flat-square)](LICENSE)

**English** | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md)

</div>

```console
$ tmux_run { "host": "build-box", "target": "work", "command": "make test" }
{"data": {"done": true, "exit_code": 2, "output": "...\nFAIL: test_parse (1 of 84)",
  "run_id": "9f2c41d0aa", "target": "%3", "elapsed_ms": 41210}}
```

An agent that drives tmux with `send-keys` has to remember to press Enter, guess when the command ended, and pick its output out of the screen. This plugin does that part once, in code. One call types the command, waits for it to end, and returns only its output and its exit code. The session stays open, so a person can `tmux attach` and watch the same screen.

## Features

- **Runs a command and returns its result**: output, exit code and time, for one line or a whole script.
- **Works on every SSH host**: give a `host` from `~/.ssh/config`. Nothing is installed on the host except tmux.
- **Survives long jobs**: a command that outlives the timeout keeps running, and `tmux_wait` picks it up later.
- **Waits for a line**: block until a server prints its ready line or a program asks a question.
- **Refuses to type into a busy pane**: a pane that runs vim or a server answers `busy`, not a garbled command.

## Quick start

```sh
claude plugin marketplace add zyx1121/marketplace
claude plugin install tmux@zyx1121
```

Codex: `codex plugin marketplace add zyx1121/marketplace`, then `codex plugin add tmux@zyx1121`.

The plugin needs Bun on this machine, and tmux on each host it drives. Open a new session and ask "Start a tmux session on my build box and run the tests there".

## Usage

| Tool | Does |
|------|------|
| `tmux_new` | starts a detached session and waits for its prompt |
| `tmux_run` | runs a shell command, returns output and exit code |
| `tmux_wait` | waits for an earlier run (`run_id`) or for a line (`pattern`) |
| `tmux_read` | returns the last lines of a pane and its state |
| `tmux_send` | types text or keys such as `C-c` into an interactive program |
| `tmux_list` | lists every pane on a host |
| `tmux_kill` | ends a session |

- Every tool takes `host`. Omit it for this machine.
- A `target` is a session name, `session:window.pane` or a pane ID such as `%3`. Results return the pane ID, which stays valid when windows move.
- Every result is an envelope: `data` on success, or `error` with a `code` and a `hint`. Codes: `invalid_input`, `unreachable`, `tmux_missing`, `not_found`, `exists`, `busy`, `dead`, `upstream_error`.

## Configuration

| Variable | Sets | Default |
|----------|------|---------|
| `TMUX_MCP_SOCKET` | a tmux socket name (`tmux -L`) on every host | the default socket |

SSH settings come from `~/.ssh/config`. Turn on connection sharing there (`ControlMaster auto`, `ControlPersist`) and each call to a host costs about 10 ms of SSH instead of a new handshake.

## How it works

`tmux_run` pastes this into the pane as one bracketed paste, then presses Enter:

```sh
 printf '%s\n' KILO_<id>_START; { <command>
}; printf '\n%s %s\n' KILO_<id>_END "$?"
```

It then reads the pane with `capture-pane`, polling from 50 ms up to 1 s, until the end marker appears. The output is the text between the 2 markers. The markers are printed by `printf`, so the echoed command line never matches them. On a remote host each tmux call runs as `ssh -o BatchMode=yes <host> -- tmux ...`, with every word shell-quoted.

## Limits

- `tmux_run` needs a POSIX shell prompt (bash, zsh, sh, dash, ksh). fish answers `busy`.
- The markers stay visible in the pane. A person watching sees them around each command.
- Output longer than the pane's history limit loses its beginning, and `truncated` is true. Results keep the last 20,000 characters.
- A host whose SSH login needs a password or a touch fails with `unreachable`. Log in once by hand with connection sharing, or use a key.
- Windows hosts are not supported. Use tmux inside WSL through an SSH host that lands there.

## For AI agents

Facts for coding agents and LLM tools. The rules for changing the code are in [AGENTS.md](AGENTS.md).

- **Summary**: Claude Code and Codex plugin with 7 MCP tools that drive tmux locally or over SSH, and return a command's output and exit code.
- **Type**: plugin
- **Interfaces**: MCP `tmux` (stdio, `dist/server.js`)
- **Install**: `claude plugin install tmux@zyx1121`, after `claude plugin marketplace add zyx1121/marketplace`
- **Run**: the host starts the MCP server
- **Verify**: `tmux_new` with a `session`, then `tmux_run` with `echo ok`, expect `exit_code` 0 and `output` "ok", then `tmux_kill`
- **Config**: `TMUX_MCP_SOCKET`, plus the user's `~/.ssh/config`
- **Secrets**: none. SSH keys stay with ssh.
- **Limits**: POSIX shells only for `tmux_run`. No Windows hosts.

## Development

```sh
bun install --frozen-lockfile
bun run check
```

The live tests need tmux and start a private server on their own socket. The marketplace pins each release commit.

## License

[MIT](LICENSE)
