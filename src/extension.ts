import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const ROOT_COMMAND = 'openExternal.openRoot';
const HERE_COMMAND = 'openExternal.openHere';
const LEGACY_ROOT_COMMAND = 'openExternalCmd.openRoot';
const LEGACY_HERE_COMMAND = 'openExternalCmd.openHere';
const WINDOWS_CMD_EXE = 'C:\\Windows\\System32\\cmd.exe';
const WINDOWS_POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

let output: vscode.OutputChannel | undefined;

interface TerminalConfiguration {
  executable: string;
  args: string[];
  environment?: Record<string, string | null>;
  label: string;
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Open External');
  context.subscriptions.push(output);

  const openRoot = async (): Promise<void> => {
    const target = resolveWorkspaceRoot() ?? (await resolveFromActiveEditor());
    if (!target) {
      void vscode.window.showWarningMessage(
        'Open External：没有可用的项目根目录。请先用“打开文件夹”打开一个项目。'
      );
      return;
    }
    await openExternalTerminal(target, '项目根目录');
  };

  const openHere = async (uri?: vscode.Uri): Promise<void> => {
    const target = await resolveTargetDirectory(uri);
    if (!target) {
      void vscode.window.showWarningMessage(
        'Open External：无法确定目录。请先选中文件/文件夹，或打开一个工作区。'
      );
      return;
    }
    await openExternalTerminal(target, '当前路径');
  };

  for (const command of [ROOT_COMMAND, LEGACY_ROOT_COMMAND]) {
    context.subscriptions.push(vscode.commands.registerCommand(command, openRoot));
  }
  for (const command of [HERE_COMMAND, LEGACY_HERE_COMMAND]) {
    context.subscriptions.push(vscode.commands.registerCommand(command, openHere));
  }
}

export function deactivate(): void {
  output?.dispose();
  output = undefined;
}

async function openExternalTerminal(directory: string, source: string): Promise<void> {
  const cwd = path.normalize(directory);
  const terminal = resolveTerminalConfiguration();
  log(`触发打开外部终端（${source}，${terminal.label}）: ${cwd}`);

  if (!fs.existsSync(cwd)) {
    void vscode.window.showErrorMessage(`Open External：目录不存在：${cwd}`);
    return;
  }

  try {
    // 使用 Start-Process 创建独立可见窗口，避免 VS Code 托管窗口影响 Ctrl+C。
    await launchExternalTerminal(cwd, terminal);
    log(`已启动外部终端（${terminal.label}）: ${cwd}`);
    void vscode.window.setStatusBarMessage(`$(terminal) 已打开外部终端（${terminal.label}）：${cwd}`, 3000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`启动失败: ${message}`);
    void vscode.window.showErrorMessage(`Open External 启动失败：${message}`);
  }
}

function resolveTerminalConfiguration(): TerminalConfiguration {
  const extensionConfig = vscode.workspace.getConfiguration('openExternal');
  const configuredShell = extensionConfig.get<string>('shell')?.trim();

  // 留空或 auto 表示跟随 VS Code；填写值则允许用户明确覆盖 VS Code 的默认终端。
  if (configuredShell && configuredShell.toLowerCase() !== 'auto') {
    return {
      executable: resolveShellReference(configuredShell, true) ?? configuredShell,
      args: normalizeArguments(extensionConfig.get<unknown>('shellArgs')),
      label: configuredShell,
    };
  }

  return resolveVsCodeTerminalConfiguration() ?? {
    executable: resolveCommandProcessor(),
    args: [],
    label: 'cmd',
  };
}

function resolveVsCodeTerminalConfiguration(): TerminalConfiguration | undefined {
  const terminalConfig = vscode.workspace.getConfiguration('terminal.integrated');
  const profileNameValue = terminalConfig.get<unknown>('defaultProfile.windows');
  const profileName = typeof profileNameValue === 'string' ? profileNameValue.trim() : undefined;
  const profiles = asRecord(terminalConfig.get<unknown>('profiles.windows'));
  const profile = profileName ? profiles?.[profileName] : undefined;
  const profileRecord = asRecord(profile);

  const profilePath = resolveProfilePath(profileRecord?.path ?? profile);
  const profileSource = typeof profileRecord?.source === 'string' ? profileRecord.source : undefined;
  const sourceExecutable = profileSource
    ? resolveShellReference(profileSource, false)
    : undefined;
  const detectedExecutable = resolveShellReference(vscode.env.shell, false);
  const namedExecutable = profileName
    ? resolveShellReference(profileName, false)
    : undefined;
  const executable = profilePath ?? sourceExecutable ?? detectedExecutable ?? namedExecutable;

  if (!executable) {
    return undefined;
  }

  const args = normalizeArguments(profileRecord?.args).map(resolveVsCodeVariables);
  const environment = normalizeEnvironment(profileRecord?.env);
  return {
    executable,
    args,
    environment,
    label: profileName || getExecutableLabel(executable),
  };
}

function resolveProfilePath(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return resolveShellReference(resolveVsCodeVariables(value), true);
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const candidates = value
    .filter((candidate): candidate is string => typeof candidate === 'string')
    .map(resolveVsCodeVariables)
    .filter((candidate) => candidate.length > 0);
  if (candidates.length === 0) {
    return undefined;
  }

  const existingCandidate = candidates.find((candidate) => fs.existsSync(candidate));
  return resolveShellReference(existingCandidate ?? candidates[0], true);
}

async function launchExternalTerminal(cwd: string, terminal: TerminalConfiguration): Promise<void> {
  const escapedCwd = escapePowerShellSingleQuoted(cwd);
  const escapedExecutable = escapePowerShellSingleQuoted(terminal.executable);
  const argumentList = terminal.args.length > 0
    ? ` -ArgumentList @(${terminal.args.map((arg) => `'${escapePowerShellSingleQuoted(arg)}'`).join(', ')})`
    : '';
  const environmentSetup = Object.entries(terminal.environment ?? {})
    .map(([key, value]) => {
      const escapedKey = escapePowerShellSingleQuoted(key);
      const escapedValue = value === null
        ? '$null'
        : `'${escapePowerShellSingleQuoted(value)}'`;
      return `[Environment]::SetEnvironmentVariable('${escapedKey}', ${escapedValue}, 'Process');`;
    })
    .join(' ');

  const ps = [
    environmentSetup,
    `$p = Start-Process -FilePath '${escapedExecutable}' -WorkingDirectory '${escapedCwd}'${argumentList} -WindowStyle Normal -PassThru;`,
    `if (-not $p) { throw 'Start-Process returned null' };`,
    `Write-Output $p.Id`,
  ].filter(Boolean).join(' ');

  const { stdout, stderr } = await execFileAsync(
    resolvePowerShellLauncher(),
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
  log(`terminal=${terminal.executable} pid=${pid}`);
}

function resolvePowerShellLauncher(): string {
  const windowsPowerShell = resolveWindowsPowerShell();
  if (fs.existsSync(windowsPowerShell)) {
    return windowsPowerShell;
  }
  return resolvePowerShell7Executable();
}

function resolveShellReference(value: string | undefined, allowUnknownCommand: boolean): string | undefined {
  if (!value) {
    return undefined;
  }

  const resolved = resolveVsCodeVariables(value).trim().replace(/^"(.*)"$/s, '$1');
  if (!resolved) {
    return undefined;
  }

  const normalized = resolved.toLowerCase();
  const hasDirectory = path.isAbsolute(resolved) || resolved.includes('\\') || resolved.includes('/');
  if (hasDirectory) {
    return resolved;
  }

  if (normalized === 'cmd' || normalized === 'cmd.exe') {
    return resolveCommandProcessor();
  }
  if (
    normalized === 'powershell' ||
    normalized === 'powershell.exe' ||
    normalized === 'windows powershell'
  ) {
    return resolveWindowsPowerShell();
  }
  if (
    normalized === 'pwsh' ||
    normalized === 'pwsh.exe' ||
    normalized === 'powershell 7' ||
    normalized === 'powershell7' ||
    normalized.startsWith('powershell 7 ')
  ) {
    return resolvePowerShell7Executable();
  }
  if (normalized === 'git bash' || normalized === 'gitbash') {
    return resolveGitBashExecutable();
  }
  if (normalized === 'bash') {
    return 'bash.exe';
  }
  if (normalized === 'wsl') {
    return 'wsl.exe';
  }
  if (normalized === 'nu' || normalized === 'nushell') {
    return 'nu.exe';
  }

  if (allowUnknownCommand || isPathLike(resolved)) {
    return resolved;
  }
  return undefined;
}

function resolveCommandProcessor(): string {
  return process.env.ComSpec || WINDOWS_CMD_EXE;
}

function resolveWindowsPowerShell(): string {
  return process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : WINDOWS_POWERSHELL_EXE;
}

function resolvePowerShell7Executable(): string {
  const candidates = [
    process.env.ProgramW6432
      ? path.join(process.env.ProgramW6432, 'PowerShell', '7', 'pwsh.exe')
      : undefined,
    process.env.ProgramFiles
      ? path.join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe')
      : undefined,
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'PowerShell', '7', 'pwsh.exe')
      : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? 'pwsh.exe';
}

function resolveGitBashExecutable(): string {
  const candidates = [
    process.env.ProgramW6432
      ? path.join(process.env.ProgramW6432, 'Git', 'bin', 'bash.exe')
      : undefined,
    process.env.ProgramFiles
      ? path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe')
      : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? 'bash.exe';
}

function normalizeArguments(value: unknown): string[] {
  if (typeof value === 'string') {
    return value ? [value] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((argument): argument is string => typeof argument === 'string');
}

function normalizeEnvironment(value: unknown): Record<string, string | null> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const environment: Record<string, string | null> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (entry === null || typeof entry === 'string') {
      environment[key] = entry === null ? null : resolveVsCodeVariables(entry);
    }
  }
  return Object.keys(environment).length > 0 ? environment : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function resolveVsCodeVariables(value: string): string {
  return value
    .replace(/\$\{env:([^}]+)\}/gi, (_match, name: string) => findEnvironmentValue(name) ?? '')
    .replace(/\$\{userHome\}/g, os.homedir())
    .replace(/\$\{workspaceFolder\}/g, resolveWorkspaceRoot() ?? '');
}

function findEnvironmentValue(name: string): string | undefined {
  const directValue = process.env[name];
  if (directValue !== undefined) {
    return directValue;
  }

  const entry = Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

function isPathLike(value: string): boolean {
  return path.isAbsolute(value) || value.includes('\\') || value.includes('/') || /\.(?:exe|cmd|bat|com)$/i.test(value);
}

function getExecutableLabel(executable: string): string {
  return path.win32.basename(executable).replace(/\.(?:exe|cmd|bat|com)$/i, '');
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

function log(message: string): void {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  output?.appendLine(line);
  console.log(`[openExternal] ${message}`);
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
