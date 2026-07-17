import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const CMD_EXE = 'C:\\Windows\\System32\\cmd.exe';
const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

let output: vscode.OutputChannel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Open External CMD');
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.commands.registerCommand('openExternalCmd.openRoot', async () => {
      const target = resolveWorkspaceRoot() ?? (await resolveFromActiveEditor());
      if (!target) {
        void vscode.window.showWarningMessage(
          'Open External CMD：没有可用的项目根目录。请先用“打开文件夹”打开一个项目。'
        );
        return;
      }
      await openExternalCmd(target, '项目根目录');
    }),
    vscode.commands.registerCommand('openExternalCmd.openHere', async (uri?: vscode.Uri) => {
      const target = await resolveTargetDirectory(uri);
      if (!target) {
        void vscode.window.showWarningMessage(
          'Open External CMD：无法确定目录。请先选中文件/文件夹，或打开一个工作区。'
        );
        return;
      }
      await openExternalCmd(target, '当前路径');
    })
  );
}

export function deactivate(): void {
  output?.dispose();
  output = undefined;
}

async function openExternalCmd(directory: string, source: string): Promise<void> {
  const cwd = path.normalize(directory);
  log(`触发打开外部 CMD（${source}）: ${cwd}`);

  if (!fs.existsSync(cwd)) {
    void vscode.window.showErrorMessage(`Open External CMD：目录不存在：${cwd}`);
    return;
  }

  try {
    // 关键：
    // 1) 不要用 spawn(..., { windowsHide: true }) 再去 start cmd
    //    CREATE_NO_WINDOW 会导致新控制台异常：VS Code 失焦、窗口闪一下或根本不出现
    // 2) 不要用无标题的 `start /D ...`，Ctrl+C 会失效
    // 可靠方式：PowerShell Start-Process + WorkingDirectory（ShellExecute）
    await launchCmdWithStartProcess(cwd);
    log(`已启动外部 CMD: ${cwd}`);
    void vscode.window.setStatusBarMessage(`$(terminal) 已打开外部 CMD：${cwd}`, 3000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`启动失败: ${message}`);
    void vscode.window.showErrorMessage(`Open External CMD 启动失败：${message}`);
  }
}

async function launchCmdWithStartProcess(cwd: string): Promise<void> {
  const escapedCwd = escapePowerShellSingleQuoted(cwd);
  const escapedCmd = escapePowerShellSingleQuoted(CMD_EXE);

  // -WindowStyle Hidden 只隐藏 powershell 自身，不影响 Start-Process 创建的可见窗口
  const ps = [
    `$p = Start-Process -FilePath '${escapedCmd}' -WorkingDirectory '${escapedCwd}' -WindowStyle Normal -PassThru;`,
    `if (-not $p) { throw 'Start-Process returned null' };`,
    `Write-Output $p.Id`,
  ].join(' ');

  const { stdout, stderr } = await execFileAsync(
    POWERSHELL_EXE,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', ps],
    {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    }
  );

  const pid = (stdout || '').trim();
  if (!pid) {
    throw new Error(stderr?.trim() || 'Start-Process 未返回进程 ID');
  }
  log(`cmd pid=${pid}`);
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

function log(message: string): void {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  output?.appendLine(line);
  console.log(`[openExternalCmd] ${message}`);
}

function resolveWorkspaceRoot(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath;
}

async function resolveFromActiveEditor(): Promise<string | undefined> {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (!active || active.scheme !== 'file') {
    return undefined;
  }
  return resolveDirectoryFromUri(active);
}

async function resolveTargetDirectory(uri?: vscode.Uri): Promise<string | undefined> {
  if (uri?.scheme === 'file') {
    return resolveDirectoryFromUri(uri);
  }

  const fromEditor = await resolveFromActiveEditor();
  if (fromEditor) {
    return fromEditor;
  }

  return resolveWorkspaceRoot();
}

async function resolveDirectoryFromUri(uri: vscode.Uri): Promise<string> {
  const fsPath = uri.fsPath;
  try {
    const stat = await fs.promises.stat(fsPath);
    return stat.isDirectory() ? fsPath : path.dirname(fsPath);
  } catch {
    return path.dirname(fsPath);
  }
}
