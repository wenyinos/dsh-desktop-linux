/** Prepare Desktop resources and publish their versions after every preparation stage succeeds. */

import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { downloadArtifact } from '@electron/get'
import extractZip from 'extract-zip'
import { readPrimaryRuntime } from '../../../packages/skill/tool-workspace-dependencies/src/index.ts'
import { desktopTargetPlatform, resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { packagingStep } from './packaging-step.mjs'
import { preparePrimaryRuntime } from './prepare-primary-runtime.ts'
import { prepareDesktopCli } from './prepare-cli.ts'
import { prepareCommandLink } from './prepare-command-link.ts'
import { prepareLinuxInstallerScripts } from './linux-installer-scripts.mjs'

const BUILD_PATHS = resolveDesktopTargetBuildPaths()
const RUNTIME_ROOT = BUILD_PATHS.runtime

type DesktopTarget = ReturnType<typeof desktopTargetPlatform>

/** Build-only members of the FreeBSD Electron package that the application never loads. */
const FREEBSD_ELECTRON_EXCLUSIONS = new Set([
  'node_headers', 'mksnapshot', 'chromedriver', 'v8_context_snapshot_generator', 'gen',
])

/**
 * Path segments from the extracted archive root to the Electron executable.
 * @param platform - Target platform of the prepared distribution.
 * @returns Segments relative to the extraction directory.
 */
function electronExecutableSegments(platform: DesktopTarget['platform']): readonly string[] {
  if (platform === 'darwin') return ['Electron.app', 'Contents', 'MacOS', 'Electron']
  return [platform === 'win32' ? 'electron.exe' : 'electron']
}

/**
 * Copy the FreeBSD system Electron distribution into the target build root.
 *
 * The FreeBSD Electron package ships the same directory layout as the Linux distribution, which
 * is what lets electron-builder assemble the application through its Linux path. The settings
 * name the installed distribution and the version electron-builder records for it; both come from
 * `.env.freebsd`, so a missing or renamed package fails here instead of mid-assembly.
 */
function prepareFreebsdElectron(): void {
  const root = process.env.DSH_DESKTOP_FREEBSD_ELECTRON_ROOT?.trim()
  const version = process.env.DSH_DESKTOP_FREEBSD_ELECTRON_VERSION?.trim()
  if (root === undefined || root === '') {
    throw new Error('desktop runtime: DSH_DESKTOP_FREEBSD_ELECTRON_ROOT must name the installed Electron distribution')
  }
  if (version === undefined || version === '') {
    throw new Error('desktop runtime: DSH_DESKTOP_FREEBSD_ELECTRON_VERSION must carry the Electron version')
  }
  rmSync(BUILD_PATHS.electron, { recursive: true, force: true })
  const normalizedRoot = root.replace(/\/+$/u, '')
  cpSync(root, BUILD_PATHS.electron, {
    recursive: true,
    filter: source => !FREEBSD_ELECTRON_EXCLUSIONS.has(source.slice(normalizedRoot.length).replace(/^\/+/u, '').split('/')[0] ?? ''),
  })
  writeFileSync(join(BUILD_PATHS.electron, 'version'), `${version}\n`)
  // The ripgrep selection package publishes no FreeBSD build, so the release carries the port's
  // binary beside the executable, which is where the search tool resolves its sidecar from.
  const ripgrep = '/usr/local/bin/rg'
  if (!existsSync(ripgrep)) {
    throw new Error(`desktop runtime: ripgrep is missing at ${ripgrep}; install textproc/ripgrep on the build host`)
  }
  cpSync(ripgrep, join(BUILD_PATHS.electron, 'electron-rg'))
}

/**
 * Prepare the target Electron distribution from the downloaded archive or the FreeBSD system
 * package, and return the Node version it embeds.
 * @param target - Platform and architecture of the prepared payload.
 * @returns The Node version the prepared Electron reports.
 */
async function prepareElectron({ platform, arch }: DesktopTarget): Promise<string> {
  if (platform === 'freebsd') {
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'install:freebsd-electron', async () => prepareFreebsdElectron())
  }
  else {
    const require = createRequire(import.meta.url)
    const { version } = require('electron/package.json') as { version: string }
    const archive = await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'download:electron',
      () => downloadArtifact({ version, platform, arch, artifactName: 'electron', cacheRoot: BUILD_PATHS.downloads }))
    rmSync(BUILD_PATHS.electron, { recursive: true, force: true })
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'extract:electron', () => extractZip(archive, { dir: BUILD_PATHS.electron }))
  }
  const executable = join(BUILD_PATHS.electron, ...electronExecutableSegments(platform))
  return execFileSync(executable, ['-p', 'process.versions.node'], {
    encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }).trim()
}

function prepareCli({ platform, arch }: DesktopTarget): void {
  cpSync(join(import.meta.dirname, 'node-bin'), join(RUNTIME_ROOT, 'bin'), { recursive: true })
  chmodSync(join(RUNTIME_ROOT, 'bin', 'node'), 0o755)
  const cli = join(RUNTIME_ROOT, 'cli')
  prepareDesktopCli(cli, platform)
  if (platform === 'darwin') {
    const minimumVersion = execFileSync('/usr/libexec/PlistBuddy', [
      '-c', 'Print LSMinimumSystemVersion', join(BUILD_PATHS.electron, 'Electron.app', 'Contents', 'Info.plist'),
    ], { encoding: 'utf8' }).trim()
    prepareCommandLink(cli, arch, minimumVersion)
  }
  cpSync(join(import.meta.dirname, '..', 'lib', 'command-manager-entry.js'), join(cli, 'command-manager.js'))
  cpSync(join(import.meta.dirname, 'command-path.ps1'), join(cli, 'command-path.ps1'))
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'defer-primary-runtime-smoke': { type: 'boolean', default: false } } })
  const target = desktopTargetPlatform(resolveDesktopBuildTarget())
  rmSync(RUNTIME_ROOT, { recursive: true, force: true })
  mkdirSync(RUNTIME_ROOT, { recursive: true })
  const nodeVersion = await prepareElectron(target)
  await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'prepare:primary-runtime',
    () => preparePrimaryRuntime({ deferSmoke: values['defer-primary-runtime-smoke'] }))
  const { pnpm } = await readPrimaryRuntime(join(RUNTIME_ROOT, 'primary-runtime'))
  if (pnpm === undefined) throw new Error('desktop runtime: primary-runtime manifest has no pnpm version')
  await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'prepare:cli', async () => { prepareCli(target) })
  // The deb and rpm install scripts put the CLI on PATH; they are written before electron-builder
  // reads its configuration, which runs after this step. A FreeBSD package places the command itself.
  if (target.platform === 'linux') {
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'prepare:linux-installer-scripts', async () => {
      const scripts = prepareLinuxInstallerScripts(BUILD_PATHS.root)
      process.stdout.write(`desktop runtime: Linux install scripts written to ${scripts.afterInstall} and ${scripts.afterRemove}\n`)
    })
  }
  writeFileSync(join(RUNTIME_ROOT, 'versions.json'), `${JSON.stringify({
    schemaVersion: 1,
    node: nodeVersion,
    pnpm,
  }, undefined, 2)}\n`)
}

await main()
