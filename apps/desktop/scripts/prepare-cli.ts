/** Package terminal launch scripts that reuse the installed Electron runtime. */

import { chmodSync, copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Copy the platform launcher into the application's public command directory.
 * @param destination - Physical runtime/cli directory prepared for the application.
 * @param platform - Target Desktop operating system.
 */
export function prepareDesktopCli(destination: string, platform: 'darwin' | 'win32' | 'linux'): void {
  const windows = platform === 'win32'
  // Linux keeps the application executable beside the resources directory, so its launcher
  // resolves that sibling rather than the macOS bundle path; both install the `dsh` command.
  const source = windows ? 'dsh.cmd' : platform === 'linux' ? 'dsh-linux' : 'dsh'
  const command = join(destination, 'bin', windows ? 'dsh.cmd' : 'dsh')
  mkdirSync(join(destination, 'bin'), { recursive: true })
  copyFileSync(join(import.meta.dirname, '..', 'cli', source), command)
  if (!windows) chmodSync(command, 0o755)
}
