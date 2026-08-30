import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import * as os from 'os';
import { escapeShellArg } from './shellEscape';

interface ShellInfo {
  path: string;
  name: string;
  args?: string[];
}

/**
 * Detects the user's default shell in a robust, cross-platform way
 */
export class ShellDetector {
  private static cachedShell: ShellInfo | null = null;

  /**
   * Get the user's default shell
   * @param forceRefresh Force re-detection instead of using cache
   * @returns Shell information including path and name
   */
  static getDefaultShell(forceRefresh = false): ShellInfo {
    if (!forceRefresh && this.cachedShell) {
      return this.cachedShell;
    }

    const shell = this.detectShell();
    this.cachedShell = shell;
    return shell;
  }

  private static detectShell(): ShellInfo {
    if (process.platform === 'win32') {
      return this.detectWindowsShell();
    }
    return this.detectUnixShell();
  }

  /**
   * Windows shell detection. Windows PowerShell 5.1 (`powershell.exe`) ships
   * with every supported Windows host at a fixed location, so it is the
   * guaranteed fallback; PowerShell 7 (`pwsh.exe`) is preferred when the user
   * installed it. cmd.exe is deliberately not used as the default interactive
   * substrate: no `-c`-style command execution and a much weaker scripting
   * surface for the flow agents.
   */
  private static detectWindowsShell(): ShellInfo {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const systemPowerShell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

    // PowerShell 7's fixed MSI install location — probe it FIRST, before the
    // PATH loop. The PATH probe cannot tell a real pwsh.exe from a 0-byte
    // Microsoft Store execution-alias stub (see below), but Program Files
    // never holds stubs, so a hit here is always the real binary.
    const pwsh7 = path.join(
      process.env.ProgramFiles || 'C:\\Program Files',
      'PowerShell', '7', 'pwsh.exe'
    );
    if (fs.existsSync(pwsh7)) {
      return { path: pwsh7, name: 'pwsh', args: this.getShellArgs('pwsh') };
    }

    // pwsh.exe: probe PATH the cheap way (no subprocess) and fall through to
    // the always-present system PowerShell. Skip 0-byte candidates: on Windows
    // fs.accessSync(X_OK) is effectively existence-only, so a Store
    // execution-alias stub (`...\Microsoft\WindowsApps\pwsh.exe`, 0 bytes
    // until first launch) passes the probe but fails on every spawn — without
    // this skip such a stub would win the scan and no PowerShell fallback
    // would ever be reached.
    const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const dir of pathDirs) {
      const candidate = path.join(dir, 'pwsh.exe');
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).size === 0) continue;
        return { path: candidate, name: 'pwsh', args: this.getShellArgs('pwsh') };
      } catch {
        // Not here (or stat raced away) — keep scanning.
      }
    }

    if (fs.existsSync(systemPowerShell)) {
      return { path: systemPowerShell, name: 'powershell', args: this.getShellArgs('powershell') };
    }

    // cmd.exe is always present — last-resort so a spawn always has a target.
    const cmd = path.join(systemRoot, 'System32', 'cmd.exe');
    return { path: cmd, name: 'cmd', args: [] };
  }

  private static detectUnixShell(): ShellInfo {
    // First, try the SHELL environment variable
    const envShell = process.env.SHELL;
    if (envShell && fs.existsSync(envShell)) {
      const name = path.basename(envShell);
      return { path: envShell, name, args: this.getShellArgs(name) };
    }

    // On macOS, try to get the default shell from Directory Services
    if (process.platform === 'darwin') {
      try {
        const username = os.userInfo().username;
        const result = execSync(`dscl . -read /Users/${username} UserShell`, { encoding: 'utf8', windowsHide: true });
        const match = result.match(/UserShell:\s*(.+)/);
        if (match && match[1]) {
          const shellPath = match[1].trim();
          if (fs.existsSync(shellPath)) {
            const name = path.basename(shellPath);
            return { path: shellPath, name, args: this.getShellArgs(name) };
          }
        }
      } catch (error) {
        // Ignore errors and continue with fallback detection
      }
    }

    // Try to read from /etc/passwd
    try {
      const username = os.userInfo().username;
      const passwdContent = fs.readFileSync('/etc/passwd', 'utf8');
      const userLine = passwdContent.split('\n').find(line => line.startsWith(`${username}:`));
      if (userLine) {
        const parts = userLine.split(':');
        const shellPath = parts[6];
        if (shellPath && fs.existsSync(shellPath)) {
          const name = path.basename(shellPath);
          return { path: shellPath, name, args: this.getShellArgs(name) };
        }
      }
    } catch (error) {
      // Ignore errors and continue with fallback detection
    }

    // Try common shell paths in order of preference
    const commonShells = [
      '/usr/local/bin/zsh',
      '/bin/zsh',
      '/usr/bin/zsh',
      '/usr/local/bin/fish',
      '/usr/bin/fish',
      '/usr/local/bin/bash',
      '/bin/bash',
      '/usr/bin/bash',
      '/bin/sh',
      '/usr/bin/sh'
    ];

    for (const shellPath of commonShells) {
      if (fs.existsSync(shellPath)) {
        const name = path.basename(shellPath);
        return { path: shellPath, name, args: this.getShellArgs(name) };
      }
    }

    // Last resort - use sh
    return { path: '/bin/sh', name: 'sh', args: ['-i'] };
  }

  private static getShellArgs(shellName: string): string[] {
    // Return appropriate arguments for interactive shell sessions
    switch (shellName) {
      case 'bash':
      case 'sh':
      case 'zsh':
      case 'fish':
        return ['-i']; // Interactive mode
      case 'pwsh':
      case 'powershell':
        return ['-NoLogo']; // Skip the banner in interactive PTY sessions
      default:
        return [];
    }
  }

  /**
   * Get shell-specific command execution arguments
   * @param command The command to execute
   * @returns Array of arguments to pass to spawn/exec
   */
  static getShellCommandArgs(command: string): { shell: string; args: string[] } {
    const shellInfo = this.getDefaultShell();
    if (process.platform === 'win32') {
      // -EncodedCommand (base64 of the UTF-16LE command string) instead of
      // -Command: `command` carries user content — quoted paths, nested
      // quotes — that -Command's argv quoting cannot survive verbatim, while
      // the encoded form reaches PowerShell byte-exact. -NonInteractive keeps
      // a script awaiting input from dropping into a REPL.
      return {
        shell: shellInfo.path,
        args: [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(command, 'utf16le').toString('base64'),
        ],
      };
    }
    return { shell: shellInfo.path, args: ['-c', command] };
  }

  /**
   * Build the command string for a multi-statement script — an optional set of
   * environment variables assigned first, then the command lines run in
   * order — in the dialect {@link getShellCommandArgs} routes to.
   *
   * POSIX: `export K='v' && line1 && line2`. PowerShell has no `export` and
   * the PS 5.1 every Windows host ships cannot parse `&&`, so the win32 form
   * assigns via the env provider (embedded single quotes doubled —
   * PowerShell's own escaping) and joins with `;`. `platform` is injectable
   * so tests pin either dialect anywhere.
   */
  static buildCommandString(
    envVars: Record<string, string>,
    commandLines: string[],
    platform: NodeJS.Platform = process.platform
  ): string {
    const parts: string[] = [];
    if (platform === 'win32') {
      for (const [key, value] of Object.entries(envVars)) {
        parts.push(`$env:${key} = '${value.replace(/'/g, "''")}'`);
      }
    } else {
      for (const [key, value] of Object.entries(envVars)) {
        parts.push(`export ${key}=${escapeShellArg(value)}`);
      }
    }
    parts.push(...commandLines);
    return parts.join(platform === 'win32' ? '; ' : ' && ');
  }

  /**
   * Check if a shell exists at the given path
   * @param shellPath Path to the shell executable
   * @returns true if the shell exists and is executable
   */
  static isShellAvailable(shellPath: string): boolean {
    try {
      fs.accessSync(shellPath, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
}