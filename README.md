# Open External CMD

在 VS Code 中打开**独立外部 CMD 窗口**（非内置终端、非 VS Code 托管外部终端），保证 `Ctrl+C` 可正常中断进程。

仓库：https://github.com/githubshaoguoyu/vscode-open-external-cmd

## 功能

| 入口 | 行为 |
|------|------|
| 快捷键 `Alt+C` | 在**项目根目录**打开外部 CMD |
| 资源管理器右键「打开外部终端」 | 文件夹：在该目录打开；文件：在文件所属目录打开 |
| 编辑器右键 / 标签页右键 | 在当前文件所属目录打开 |
| 命令面板 | `打开外部终端（项目根目录）` / `打开外部终端` |

## 为什么不用内置/官方外部终端

- Task 启动会在内置终端留下任务面板
- `workbench.action.terminal.openNativeConsole` 拉起的窗口上，`Ctrl+C` 在 Windows 上经常无法正常打断命令

本扩展通过 PowerShell `Start-Process -WorkingDirectory` 启动独立 `cmd.exe` 窗口（不走 VS Code Task / `openNativeConsole`）。

> Windows 注意：`cmd /c start /D "dir" cmd.exe`（无窗口标题）会把路径误解析，导致新控制台里 `Ctrl+C` 无法中断 `npm run serve` 等子进程。

## 快捷键说明

安装后默认快捷键为 `Alt+C`。扩展会自动覆盖 VS Code 默认的“切换区分大小写”等 `Alt+C` 绑定。  
若无效，请到“键盘快捷方式”搜索 `Alt+C`，确认没有其他用户自定义绑定冲突。

## 调试

```bash
cd D:\project\openExternalCmd
npm install
npm run compile
```

用 VS Code 打开本目录，按 `F5` 启动 Extension Development Host 测试。

## 安装到本机

打包：

```bash
npm run package
```

然后：

```bash
code --install-extension open-external-cmd-0.0.5.vsix
```
