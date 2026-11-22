<div align="center">

<h1>tmux</h1>

<p><strong>讓 agent 在任何 SSH 主機的 tmux 裡跑指令，拿回輸出與 exit code。</strong></p>

[![CI](https://img.shields.io/github/actions/workflow/status/zyx1121/tmux/check.yml?branch=main&style=flat-square&label=CI)](https://github.com/zyx1121/tmux/actions)
[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-D97757?style=flat-square)](https://github.com/zyx1121/marketplace)
[![License](https://img.shields.io/github/license/zyx1121/tmux?style=flat-square)](LICENSE)

[English](README.md) | **繁體中文** | [简体中文](README.zh-CN.md)

</div>

```console
$ tmux_run { "host": "build-box", "target": "work", "command": "make test" }
{"data": {"done": true, "exit_code": 2, "output": "...\nFAIL: test_parse (1 of 84)",
  "run_id": "9f2c41d0aa", "target": "%3", "elapsed_ms": 41210}}
```

用 `send-keys` 操作 tmux 的 agent，要記得按 Enter、猜指令何時結束，還要從畫面裡挑出輸出。這個插件把這些寫死在程式裡：一次呼叫就送出指令、等它結束，只回傳它的輸出與 exit code。session 會留著，人可以 `tmux attach` 看同一個畫面。

## 功能

- **跑指令並回傳結果**：輸出、exit code 與耗時，單行或整段腳本都行。
- **任何 SSH 主機都能用**：`host` 填 `~/.ssh/config` 裡的名稱。主機上只需要 tmux。
- **長時間工作不中斷**：超過 timeout 的指令會繼續跑，之後用 `tmux_wait` 接手。
- **等待特定輸出**：等到 server 印出就緒訊息，或程式跳出提問。
- **不會打進忙碌的 pane**：pane 正在跑 vim 或 server 時回 `busy`，不會打出亂掉的指令。

## 快速開始

```sh
claude plugin marketplace add zyx1121/marketplace
claude plugin install tmux@zyx1121
```

Codex：`codex plugin marketplace add zyx1121/marketplace`，再 `codex plugin add tmux@zyx1121`。

本機需要 Bun，被操作的主機需要 tmux。開新 session 後問「在 build 機開一個 tmux session 跑測試」。

## 使用

| Tool | 用途 |
|------|------|
| `tmux_new` | 開一個背景 session，等到出現提示字元 |
| `tmux_run` | 跑 shell 指令，回傳輸出與 exit code |
| `tmux_wait` | 等先前的指令(`run_id`)結束，或等某行出現(`pattern`) |
| `tmux_read` | 讀 pane 最後幾行與狀態 |
| `tmux_send` | 對互動程式輸入文字或按鍵，例如 `C-c` |
| `tmux_list` | 列出主機上所有 pane |
| `tmux_kill` | 結束 session |

- 每個 tool 都有 `host`，省略就是本機。
- `target` 可以是 session 名稱、`session:window.pane`，或 pane ID 例如 `%3`。結果會回傳 pane ID，視窗移動後仍然有效。
- 結果格式一致：成功時有 `data`，失敗時有 `error`，附 `code` 與 `hint`。

## 設定

| 變數 | 用途 | 預設 |
|------|------|------|
| `TMUX_MCP_SOCKET` | 每台主機使用的 tmux socket 名稱(`tmux -L`) | 預設 socket |

SSH 設定沿用 `~/.ssh/config`。在那裡開啟共用連線(`ControlMaster auto`、`ControlPersist`)，每次呼叫只花約 10 ms，不用重新握手。

## 限制

- `tmux_run` 需要 POSIX shell(bash、zsh、sh、dash、ksh)，fish 會回 `busy`。
- 標記行會留在 pane 畫面上。
- 輸出超過 pane 的歷史上限時會遺失開頭，`truncated` 為 true。結果保留最後 20,000 字元。
- SSH 登入需要密碼或觸控確認的主機會回 `unreachable`。
- 不支援 Windows 主機，請透過 SSH 進 WSL 使用 tmux。

## 授權

[MIT](LICENSE)
