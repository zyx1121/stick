<div align="center">

<h1>stick</h1>

<p><strong>1 個 MCP 工具操作每一台能 ssh 的機器：在 Linux 或 Windows 跑指令、操作 tmux、使用 Windows 桌面。</strong></p>

[![CI](https://img.shields.io/github/actions/workflow/status/zyx1121/stick/check.yml?branch=main&style=flat-square&label=CI)](https://github.com/zyx1121/stick/actions)
[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-D97757?style=flat-square)](https://github.com/zyx1121/marketplace)
[![License](https://img.shields.io/github/license/zyx1121/stick?style=flat-square)](LICENSE)

[English](README.md) | **繁體中文** | [简体中文](README.zh-CN.md)

</div>

```console
$ exec { "host": "win-box", "command": "Get-Item \"C:\\Users\\me\"; \"中文 'ok'\"; exit 7" }
{"data": {"os": "windows", "exit_code": 7, "stdout": "C:\\Users\\me\n中文 'ok'\n", "stderr": ""}}
```

用 `ssh host '...'` 送出的指令，路上會經過 2 到 4 個解析器：本機 shell、ssh，再來是 bash，或是 Windows 上的 cmd、PowerShell，甚至 WSL。每一層都用自己的方式吃掉引號、反斜線或分號，Windows 還會用自己的編碼回答。agent 只好一直改寫同一條指令。stick 改把指令從 stdin 送過去，中間的解析器都看不到它，回來的一律是 UTF-8 加 exit code。

## 功能

- **每種系統同一個呼叫**：`exec` 帶主機和腳本。posix 主機寫 bash，Windows 主機寫 PowerShell，傳送方式由工具決定。
- **不用跳脫**：引號、反斜線、分號、中文原樣送達，也不受 cmd 8191 字元上限限制。
- **長時間工作放 tmux**：`tmux_run` 在提示字元打指令、等它結束，只回傳它的輸出與 exit code。
- **Windows 桌面變文字**：`desktop` 把視窗讀成文字樹，可以點擊、輸入、拍小截圖，截圖存到本機。
- **記得每台主機**：第 1 次連線時偵測系統並記住。

## 快速開始

```sh
claude plugin marketplace add zyx1121/marketplace
claude plugin install stick@zyx1121
```

本機需要 Bun，每台主機要能用金鑰 ssh 登入。tmux 工具需要主機裝 tmux。桌面工具要先對每台 Windows 主機呼叫一次 `desktop_install`。

## 使用

| Tool | 用途 | 系統 |
|------|------|------|
| `hosts` | 列出 `~/.ssh/config` 的主機，或偵測一台的系統 | 全部 |
| `exec` | 跑腳本，回傳 stdout、stderr 與 exit code | 全部 |
| `tmux_*` | 開 session、跑指令、等待、讀取、輸入、列出、結束 | posix |
| `desktop` | 桌面指令：`windows`、`snap`、`click`、`type`、`shot` | Windows |
| `desktop_install` | 在主機上編譯並啟動桌面 daemon | Windows |

## 限制

- 不會在 bash 和 PowerShell 之間翻譯。`hosts` 和結果的 `os` 欄位會告訴你該寫哪一種。
- ssh 登入需要密碼或觸控確認的主機會回 `unreachable`。
- Windows 主機沒有 tmux，要用 WSL 請透過它自己的 ssh 主機。
- 桌面 daemon 需要有人登入在主控台。

## 授權

[MIT](LICENSE)
