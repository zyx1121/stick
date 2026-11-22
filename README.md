<div align="center">

<h1>stick</h1>

<p><strong>One MCP tool for every machine you can ssh into: run commands on Linux or Windows, drive tmux, and use a Windows desktop.</strong></p>

[![CI](https://img.shields.io/github/actions/workflow/status/zyx1121/stick/check.yml?branch=main&style=flat-square&label=CI)](https://github.com/zyx1121/stick/actions)
[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-D97757?style=flat-square)](https://github.com/zyx1121/marketplace)
[![License](https://img.shields.io/github/license/zyx1121/stick?style=flat-square)](LICENSE)

**English** | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md)

</div>

```console
$ exec { "host": "win-box", "command": "Get-Item \"C:\\Users\\me\"; \"中文 'ok'\"; exit 7" }
{"data": {"os": "windows", "exit_code": 7, "stdout": "C:\\Users\\me\n中文 'ok'\n", "stderr": ""}}

$ exec { "host": "build-box", "command": "uname -s; ls /nope" }
{"data": {"os": "posix", "exit_code": 2, "stdout": "Linux\n", "stderr": "ls: cannot access '/nope': ..."}}
```

A command sent with `ssh host '...'` passes through 2 to 4 parsers on its way: your shell, ssh, then bash, or cmd, PowerShell and maybe WSL on Windows. Each one eats quotes, backslashes or semicolons in its own way, and a Windows machine answers in its own code page. An agent ends up rewriting the same command until it survives. stick sends every command on stdin instead, so no parser in between ever sees it, and every answer comes back as UTF-8 with an exit code.

## Features

- **Same call on every OS**: `exec` takes a host and a script. Write bash for a posix host and PowerShell for a Windows host. The tool picks the transport.
- **Nothing to escape**: quotes, backslashes, semicolons and non-ASCII text arrive unchanged, and scripts are not limited by cmd's 8191 characters.
- **Long jobs in tmux**: `tmux_run` types a command at a shell prompt, waits, and returns only its output and exit code. A person can `tmux attach` and watch.
- **A Windows desktop as text**: `desktop` reads windows as a text tree, clicks, types and takes small screenshots that land on this machine.
- **Knows each host**: the OS is detected on first contact and remembered.

## Quick start

```sh
claude plugin marketplace add zyx1121/marketplace
claude plugin install stick@zyx1121
```

Codex: `codex plugin marketplace add zyx1121/marketplace`, then `codex plugin add stick@zyx1121`.

The plugin needs Bun on this machine and key-based ssh to each host. tmux tools need tmux on the host. For the desktop tools, call `desktop_install` once per Windows host. Then ask "What is using disk space on my Windows box?".

## Usage

| Tool | Does | OS |
|------|------|----|
| `hosts` | lists `~/.ssh/config` hosts, or probes one host's OS | any |
| `exec` | runs a script, returns stdout, stderr and exit code | any |
| `tmux_new` | starts a detached session and waits for its prompt | posix |
| `tmux_run` | runs a command in a pane, returns its output and exit code | posix |
| `tmux_wait` | waits for an earlier run, or for a line on screen | posix |
| `tmux_read`, `tmux_send` | reads a pane, or types text and keys such as `C-c` | posix |
| `tmux_list`, `tmux_kill` | lists panes, ends a session | posix |
| `desktop` | runs desktop commands: `windows`, `snap`, `click`, `type`, `shot` | Windows |
| `desktop_install` | builds and starts the desktop daemon on a host | Windows |

- Every tool takes `host`. Omit it for this machine.
- Every result is an envelope: `data` on success, or `error` with a `code` and a `hint`.
- On Windows the exit code is the last native program's code, or 1 when PowerShell wrote an error. Each Windows call costs about 1 s more than a posix one.
- `exec` stops the local ssh at `timeout_s`. On Windows it then kills the remote program by its recorded PID with a second ssh call, so a timed out job stops. If that call fails too, the program can keep running; use a scheduled task or WSL tmux for long jobs there.

## Configuration

| Variable | Sets | Default |
|----------|------|---------|
| `STICK_TMUX_SOCKET` | a tmux socket name (`tmux -L`) on every host | the default socket |

SSH settings come from `~/.ssh/config`. Turn on connection sharing there (`ControlMaster auto`, `ControlPersist`) and each call costs about 10 ms of ssh instead of a new handshake.

## How it works

- **posix**: `ssh host -- sh -c '...'` saves the script from stdin to a temp file, then runs it with bash and stdin on `/dev/null`. The file lives in a private `stick-<uid>` folder (mode 0700) under `TMPDIR` or `/tmp`. The runner checks that folder once and then uses its path, so keep `TMPDIR` out of a world-writable folder without the sticky bit: there another user could swap the folder between the check and the use. A sticky `/tmp` or a per-user `TMPDIR` is safe.
- **Windows**: `ssh host -- powershell -EncodedCommand <wrapper>`. The fixed wrapper reads the script from stdin as base64 lines (Windows OpenSSH never signals end of input, so a line holding `.` ends it), then runs it in a child PowerShell with UTF-8 output and an empty stdin, so programs such as git never wait for input.
- **tmux**: each tmux call goes through ssh with every word quoted. `tmux_run` pastes the command between 2 printf markers and polls `capture-pane` until the end marker shows.
- **desktop**: a daemon (`windows/fwd.cs`, built with the C# compiler that ships with Windows) runs in the logged-in session and listens on `127.0.0.1` only, behind a token readable by its owner. stick reaches it through an ssh tunnel.

## Limits

- The tool does not translate between bash and PowerShell. `hosts` and the `os` field tell you which one to write.
- A host whose ssh login needs a password or a touch fails with `unreachable`.
- tmux tools need a POSIX shell prompt (bash, zsh, sh, dash, ksh). Windows hosts have no tmux; reach WSL through its own ssh host.
- The desktop daemon needs someone logged in at the console.

## For AI agents

Facts for coding agents and LLM tools. The rules for changing the code are in [AGENTS.md](AGENTS.md).

- **Summary**: Claude Code and Codex plugin with 11 MCP tools that run commands on Linux and Windows hosts over ssh, drive tmux and use a Windows desktop.
- **Type**: plugin
- **Interfaces**: MCP `stick` (stdio, `dist/server.js`)
- **Install**: `claude plugin install stick@zyx1121`, after `claude plugin marketplace add zyx1121/marketplace`
- **Run**: the host starts the MCP server
- **Verify**: `hosts` with a host, then `exec` with `echo ok`; expect `exit_code` 0
- **Config**: `STICK_TMUX_SOCKET`, plus the user's `~/.ssh/config`
- **Secrets**: none of its own. ssh keys stay with ssh; the desktop token stays on the Windows host and in memory.
- **Limits**: no bash to PowerShell translation; tmux on posix only; desktop on Windows only.

## Development

```sh
bun install --frozen-lockfile
bun run check
```

The tests run bash and a private tmux server. Windows paths are checked by hand against a real host. The marketplace pins each release commit.

## License

[MIT](LICENSE)
