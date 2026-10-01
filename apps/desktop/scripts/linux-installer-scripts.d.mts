/** Directory inside a target build root that holds the generated install scripts. */
export const LINUX_INSTALLER_SCRIPTS_DIRECTORY: string

/** Generated install scripts for one packaging target. */
export interface LinuxInstallerScripts {
  /** Install script passed to the deb and rpm builders. */
  readonly afterInstall: string
  /** Removal script passed to the deb and rpm builders. */
  readonly afterRemove: string
}

/**
 * Resolve the install scripts a target build root holds, without writing them.
 * @param buildRoot - Target build root.
 * @returns Paths the packaging configuration expects to exist.
 */
export function linuxInstallerScriptPaths(buildRoot: string): LinuxInstallerScripts

/**
 * Write the deb and rpm install scripts for one target.
 * @param buildRoot - Target build root that receives the generated scripts.
 * @returns Paths of the written scripts.
 */
export function prepareLinuxInstallerScripts(buildRoot: string): LinuxInstallerScripts
