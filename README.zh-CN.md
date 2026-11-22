<div align="center">

<h1>stick</h1>

<p><strong>1 个 MCP 工具操作每一台能 ssh 的机器：在 Linux 或 Windows 运行命令、操作 tmux、使用 Windows 桌面。</strong></p>

[![CI](https://img.shields.io/github/actions/workflow/status/zyx1121/stick/check.yml?branch=main&style=flat-square&label=CI)](https://github.com/zyx1121/stick/actions)
[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-D97757?style=flat-square)](https://github.com/zyx1121/marketplace)
[![License](https://img.shields.io/github/license/zyx1121/stick?style=flat-square)](LICENSE)

[English](README.md) | [繁體中文](README.zh-TW.md) | **简体中文**

</div>

用 `ssh host '...'` 发送的命令，路上会经过 2 到 4 个解析器，每一层都可能吃掉引号、反斜线或分号，Windows 还会用自己的编码回答。stick 改为把命令从 stdin 送过去，中间的解析器都看不到它，返回的一律是 UTF-8 加 exit code。

## 功能

- **每种系统同一个调用**：`exec` 带主机和脚本。posix 主机写 bash，Windows 主机写 PowerShell。
- **不用转义**：引号、反斜线、分号、中文原样送达。
- **长时间任务放 tmux**：`tmux_run` 返回命令的输出与 exit code。
- **Windows 桌面变文字**：`desktop` 把窗口读成文字树，可以点击、输入、截图。

## 快速开始

```sh
claude plugin marketplace add zyx1121/marketplace
claude plugin install stick@zyx1121
```

## 限制

- 不会在 bash 和 PowerShell 之间翻译。
- 脚本存放在每个用户私有的 0700 文件夹（posix 为 `TMPDIR` 或 `/tmp` 下的 `stick-<uid>`，Windows 为 `%TEMP%\stick`），正常结束时删除；超时杀掉 runner 时，超过一天的文件会在之后的调用中清除。
- Windows 主机没有 tmux。
- 桌面 daemon 需要有人登录在控制台。

## 许可

[MIT](LICENSE)
