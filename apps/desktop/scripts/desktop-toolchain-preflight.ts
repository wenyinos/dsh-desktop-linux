/**
 * Probe the external tools a packaging run will shell out to, before it starts.
 *
 * The packaging sequence reaches its first archive step minutes in, and its
 * first installer step later still, so a tool that is absent or behaves
 * differently than the scripts assume wastes a whole run. Each probe here
 * exercises the specific behaviour the run depends on rather than merely
 * checking that the executable resolves.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** One tool the packaging run requires, and what went wrong with it. */
export interface DesktopToolchainProbeFailure {
  readonly tool: string
  readonly detail: string
}

async function probeTar(): Promise<string | undefined> {
  // GNU tar reads the colon in an absolute Windows path as a remote-host separator, which the
  // release scripts avoid by running beside the archive; this probe confirms the archive reader works there.
  const directory = await mkdtemp(join(tmpdir(), 'dsh-tar-probe-'))
  try {
    const member = join(directory, 'probe.txt')
    await writeFile(member, 'probe\n')
    const archive = join(directory, 'probe.tar.gz')
    await run('tar', ['-czf', basename(archive), basename(member)], { cwd: directory, windowsHide: true, timeout: 20_000 })
    const listed = await run('tar', ['-tzf', basename(archive)], { cwd: dirname(archive), windowsHide: true, timeout: 20_000 })
    if (!listed.stdout.includes('probe.txt')) return `tar listed ${JSON.stringify(listed.stdout)} instead of the archived member`
    return undefined
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function probeWindowsInstallerToolchain(environment: NodeJS.ProcessEnv): Promise<DesktopToolchainProbeFailure[]> {
  const failures: DesktopToolchainProbeFailure[] = []
  const programFiles = environment['ProgramFiles(x86)']
  const vswhere = programFiles === undefined
    ? undefined
    : join(programFiles, 'Microsoft Visual Studio/Installer/vswhere.exe')
  if (vswhere === undefined) {
    failures.push({ tool: 'vswhere', detail: 'ProgramFiles(x86) is not set, so Visual Studio cannot be located' })
  }
  else {
    try {
      const located = await run(vswhere, ['-latest', '-products', '*',
        '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'],
      { windowsHide: true, timeout: 30_000 })
      if (located.stdout.trim() === '') {
        failures.push({ tool: 'vswhere', detail: 'Visual Studio C++ build tools are not installed, so the installer helper cannot compile' })
      }
    }
    catch (error) {
      failures.push({ tool: 'vswhere', detail: error instanceof Error ? error.message : String(error) })
    }
  }
  return failures
}

/** One external command the packaging run needs, with the reason it is required. */
const LINUX_PACKAGE_TOOLS: readonly { readonly tool: string; readonly args: readonly string[]; readonly reason: string }[] = [
  // electron-builder bundles fpm, but rpm conversion still shells out to the system rpmbuild and xz.
  { tool: 'rpmbuild', args: ['--version'], reason: 'rpmbuild is required to build the rpm package' },
  { tool: 'xz', args: ['--version'], reason: 'xz is required to compress the rpm package' },
  // dpkg-deb validates the assembled deb during packaging; fpm itself needs a dpkg-capable host.
  { tool: 'dpkg-deb', args: ['--version'], reason: 'dpkg-deb is required to build the deb package' },
]

/**
 * One external command a FreeBSD packaging run needs. The run compiles the flock addon and
 * rebuilds node-pty from source, so the node-gyp toolchain has to exist before the first build
 * step instead of failing minutes into the runtime installation.
 */
const FREEBSD_PACKAGE_TOOLS: readonly { readonly tool: string; readonly args: readonly string[]; readonly reason: string }[] = [
  { tool: 'pkg', args: ['--version'], reason: 'pkg is required to assemble the FreeBSD package' },
  { tool: 'cc', args: ['--version'], reason: 'a C compiler is required to build the native addons' },
  { tool: 'gmake', args: ['--version'], reason: 'gmake is required because node-gyp drives GNU make on FreeBSD' },
  { tool: 'python3', args: ['--version'], reason: 'python3 is required by node-gyp' },
]

async function probeCommand(tool: string, args: readonly string[]): Promise<string | undefined> {
  try {
    await run(tool, [...args], { timeout: 20_000, windowsHide: true })
    return undefined
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function probeLinuxPackageToolchain(): Promise<DesktopToolchainProbeFailure[]> {
  const failures: DesktopToolchainProbeFailure[] = []
  for (const { tool, args, reason } of LINUX_PACKAGE_TOOLS) {
    const detail = await probeCommand(tool, args)
    if (detail !== undefined) failures.push({ tool, detail: `${reason} (${detail})` })
  }
  return failures
}

async function probeFreeBSDPackageToolchain(): Promise<DesktopToolchainProbeFailure[]> {
  const failures: DesktopToolchainProbeFailure[] = []
  for (const { tool, args, reason } of FREEBSD_PACKAGE_TOOLS) {
    const detail = await probeCommand(tool, args)
    if (detail !== undefined) failures.push({ tool, detail: `${reason} (${detail})` })
  }
  return failures
}

/**
 * Probe every external tool one packaging run needs.
 * @param platform - Target platform; a Windows target already requires a Windows build host.
 * @param environment - Packaging environment used to locate Windows tooling.
 * @returns Every probe that failed, empty when the host can run the packaging sequence.
 */
export async function probeDesktopToolchain(
  platform: 'darwin' | 'win32' | 'linux' | 'freebsd',
  environment: NodeJS.ProcessEnv = process.env,
): Promise<readonly DesktopToolchainProbeFailure[]> {
  const failures: DesktopToolchainProbeFailure[] = []
  const tar = await probeTar()
  if (tar !== undefined) failures.push({ tool: 'tar', detail: tar })
  if (platform === 'win32') failures.push(...await probeWindowsInstallerToolchain(environment))
  if (platform === 'linux') failures.push(...await probeLinuxPackageToolchain())
  if (platform === 'freebsd') failures.push(...await probeFreeBSDPackageToolchain())
  return failures
}

/**
 * Probe the toolchain and fail with every problem the host has.
 * @param platform - Target platform; a Windows target already requires a Windows build host.
 * @param environment - Packaging environment used to locate Windows tooling.
 * @returns Resolves when every probe passes.
 */
export async function requireDesktopToolchain(
  platform: 'darwin' | 'win32' | 'linux' | 'freebsd',
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const failures = await probeDesktopToolchain(platform, environment)
  if (failures.length === 0) return
  throw new Error(`desktop package: the build host cannot run this packaging sequence:\n${
    failures.map(failure => `  ${failure.tool}: ${failure.detail}`).join('\n')}`)
}
