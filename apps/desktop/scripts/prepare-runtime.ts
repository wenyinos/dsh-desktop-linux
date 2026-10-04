/** Prepare the target Electron distribution and pinned pnpm CLI. */

import { packagingStep } from './packaging-step.mjs'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { downloadArtifact } from '@electron/get'
import extractZip from 'extract-zip'
import { resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths, desktopTargetPlatform } from './desktop-build-paths.mjs'
import { preparePrimaryRuntime } from './prepare-primary-runtime.ts'
import { prepareDesktopCli } from './prepare-cli.ts'
import { prepareCommandLink } from './prepare-command-link.ts'
import { prepareLinuxInstallerScripts } from './linux-installer-scripts.mjs'

const BUILD_PATHS = resolveDesktopTargetBuildPaths()
const RUNTIME_ROOT = BUILD_PATHS.runtime

/** Build-only members of the FreeBSD Electron package that the application never loads. */
const FREEBSD_ELECTRON_EXCLUSIONS = new Set([
  'node_headers', 'mksnapshot', 'chromedriver', 'v8_context_snapshot_generator', 'gen',
])

/**
 * Path segments from the extracted archive root to the Electron executable.
 * @param platform - Target platform of the prepared distribution.
 * @returns Segments relative to the extraction directory.
 */
function electronExecutableSegments(platform: 'darwin' | 'win32' | 'linux' | 'freebsd'): readonly string[] {
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
}

/**
 * Prepare the target's Electron distribution across the archive download or the FreeBSD system
 * package, then record the Node version the bundled distribution reports.
 * @param platform - Target platform of the prepared distribution.
 * @param arch - Target architecture of the prepared distribution.
 * @returns The Node version the prepared Electron reports.
 */
async function prepareElectron(platform: 'darwin' | 'win32' | 'linux' | 'freebsd', arch: string): Promise<string> {
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

function preparePnpm(): string {
  const require = createRequire(import.meta.url)
  const manifestPath = require.resolve('pnpm')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error('desktop runtime: pnpm manifest has no version')
  const packageDir = dirname(manifestPath)
  const destination = join(RUNTIME_ROOT, 'pnpm')
  rmSync(destination, { recursive: true, force: true })
  cpSync(packageDir, destination, { recursive: true })
  return manifest.version
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'defer-primary-runtime-smoke': { type: 'boolean', default: false } } })
  const target = resolveDesktopBuildTarget()
  const { platform, arch } = desktopTargetPlatform(target)
  const nodeVersion = await prepareElectron(platform, arch)
  const macosMinimumVersion = platform === 'darwin' ? execFileSync('/usr/libexec/PlistBuddy',
    ['-c', 'Print LSMinimumSystemVersion', join(BUILD_PATHS.electron, 'Electron.app', 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim() : undefined
  rmSync(RUNTIME_ROOT, { recursive: true, force: true })
  mkdirSync(RUNTIME_ROOT, { recursive: true })
  const pnpmVersion = preparePnpm()
  cpSync(join(import.meta.dirname, 'node-bin'), join(RUNTIME_ROOT, 'bin'), { recursive: true })
  chmodSync(join(RUNTIME_ROOT, 'bin', 'node'), 0o755)
  writeFileSync(join(RUNTIME_ROOT, 'versions.json'), `${JSON.stringify({
    schemaVersion: 1,
    node: nodeVersion,
    pnpm: pnpmVersion,
  }, undefined, 2)}\n`)
  await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'prepare:cli',
    async () => prepareDesktopCli(join(RUNTIME_ROOT, 'cli'), platform))
  if (macosMinimumVersion !== undefined) prepareCommandLink(join(RUNTIME_ROOT, 'cli'), arch, macosMinimumVersion)
  cpSync(join(import.meta.dirname, '..', 'lib', 'command-manager-entry.js'), join(RUNTIME_ROOT, 'cli', 'command-manager.js'))
  cpSync(join(import.meta.dirname, 'command-path.ps1'), join(RUNTIME_ROOT, 'cli', 'command-path.ps1'))
  // The deb and rpm install scripts put the CLI on PATH; they are written before electron-builder
  // reads its configuration, which runs after this step. A FreeBSD package places the command itself.
  if (platform === 'linux') {
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'prepare:linux-installer-scripts', async () => {
      const scripts = prepareLinuxInstallerScripts(BUILD_PATHS.root)
      process.stdout.write(`desktop runtime: Linux install scripts written to ${scripts.afterInstall} and ${scripts.afterRemove}\n`)
    })
  }
  await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'prepare:primary-runtime',
    () => preparePrimaryRuntime({ deferSmoke: values['defer-primary-runtime-smoke'] }))
}

await main()
