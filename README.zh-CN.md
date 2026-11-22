<div align="center">

<h1>tmux</h1>

<p><strong>让 agent 在任何 SSH 主机的 tmux 里运行命令，拿回输出与 exit code。</strong></p>

[![CI](https://img.shields.io/github/actions/workflow/status/zyx1121/tmux/check.yml?branch=main&style=flat-square&label=CI)](https://github.com/zyx1121/tmux/actions)
[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-D97757?style=flat-square)](https://github.com/zyx1121/marketplace)
[![License](https://img.shields.io/github/license/zyx1121/tmux?style=flat-square)](LICENSE)

[English](README.md) | [繁體中文](README.zh-TW.md) | **简体中文**

</div>

```console
$ tmux_run { "host": "build-box", "target": "work", "command": "make test" }
{"data": {"done": true, "exit_code": 2, "output": "...\nFAIL: test_parse (1 of 84)",
  "run_id": "9f2c41d0aa", "target": "%3", "elapsed_ms": 41210}}
```

用 `send-keys` 操作 tmux 的 agent，要记得按 Enter、猜命令何时结束，还要从屏幕里挑出输出。这个插件把这些写死在代码里：一次调用就发送命令、等它结束，只返回它的输出与 exit code。session 会保留，人可以 `tmux attach` 看同一个画面。

## 功能

- **运行命令并返回结果**：输出、exit code 与耗时，单行或整段脚本都行。
- **任何 SSH 主机都能用**：`host` 填 `~/.ssh/config` 里的名称。主机上只需要 tmux。
- **长时间任务不中断**：超过 timeout 的命令会继续运行，之后用 `tmux_wait` 接手。
- **等待特定输出**：等到 server 打印就绪信息，或程序弹出提问。
- **不会输入到忙碌的 pane**：pane 正在运行 vim 或 server 时返回 `busy`。

## 快速开始

```sh
claude plugin marketplace add zyx1121/marketplace
claude plugin install tmux@zyx1121
```

Codex：`codex plugin marketplace add zyx1121/marketplace`，再 `codex plugin add tmux@zyx1121`。

本机需要 Bun，被操作的主机需要 tmux。

## 使用

| Tool | 用途 |
|------|------|
| `tmux_new` | 开一个后台 session，等到出现提示符 |
| `tmux_run` | 运行 shell 命令，返回输出与 exit code |
| `tmux_wait` | 等之前的命令(`run_id`)结束，或等某行出现(`pattern`) |
| `tmux_read` | 读取 pane 最后几行与状态 |
| `tmux_send` | 向交互程序输入文字或按键，例如 `C-c` |
| `tmux_list` | 列出主机上所有 pane |
| `tmux_kill` | 结束 session |

## 限制

- `tmux_run` 需要 POSIX shell(bash、zsh、sh、dash、ksh)，fish 会返回 `busy`。
- 输出超过 pane 的历史上限时会丢失开头，`truncated` 为 true。
- 不支持 Windows 主机，请通过 SSH 进入 WSL 使用 tmux。

## 许可

[MIT](LICENSE)
