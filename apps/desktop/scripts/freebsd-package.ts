/**
 * Assemble the FreeBSD package from the directory electron-builder produced.
 *
 * The application is assembled through electron-builder's Linux path because a FreeBSD Electron
 * distribution has the Linux directory layout. This step turns that verified directory into the
 * one packaged form this target ships: a pkg(8) package installing under `/usr/local`, with the
 * launcher, desktop entry, and icon set the Linux packages install as well. The runtime
 * dependency list is copied from the installed FreeBSD Electron package, so the package depends
 * on exactly the libraries that distribution was built and tested against.
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { desktopTargetPlatform, resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { DESKTOP_BUILD_VERSION_ENV } from './desktop-build-version.mjs'

const APP_ROOT = resolve(import.meta.dirname, '..')
const LINUX_ICONS = join(APP_ROOT, 'resources', 'linux-icons')
const PRODUCT_NAME = 'DeepSeek Harness'
const PRODUCT_URL = 'https://github.com/deepseek-ai/deepseek-harness'
/** Virtual port origin recorded in the package, following the FreeBSD `category/port` form. */
const PACKAGE_ORIGIN = 'deskutils/deepseek-harness'
const DEFAULT_MAINTAINER = 'DeepSeek <support@deepseek.com>'
const DEFAULT_PACKAGE_NAME = 'deepseek-harness'
const PREFIX = '/usr/local'

/** Icon files the Linux icon set renders, named `<width>x<height>.png`. */
const ICON_PATTERN = /^(\d+)x(\d+)\.png$/u

function requireSetting(name: string): string {
  const value = process.env[name]?.trim()
  if (value === undefined || value === '') throw new Error(`freebsd package: ${name} must be set`)
  return value
}

/**
 * Locate the assembled application directory electron-builder wrote for this architecture.
 * @param artifacts - Target artifacts directory.
 * @param arch - Target architecture.
 * @returns Absolute path of the unpacked application directory.
 */
function assembledApplication(artifacts: string, arch: string): string {
  const unpacked = join(artifacts, arch === 'x64' ? 'linux-unpacked' : `linux-${arch}-unpacked`)
  if (!existsSync(unpacked)) {
    throw new Error(`freebsd package: ${unpacked} does not exist; electron-builder did not produce the application`)
  }
  return unpacked
}

/** Runtime dependency map in pkg manifest form: package name to origin and version. */
type PackageDependencies = Record<string, { origin: string; version: string }>

/**
 * Read the runtime dependencies of the installed FreeBSD Electron package.
 *
 * The package database keeps each installed package's manifest under `/var/db/pkg`, and the
 * Electron package's own dependency map is the authoritative list of the libraries its binaries
 * need. Its version values are the ones this build ran against, which is what a dependency
 * records; pkg(8) resolves them by name and origin on the installing system.
 * @param electronRoot - Installed Electron distribution directory, e.g. `/usr/local/share/electron44`.
 * @returns Dependency map in pkg manifest form.
 */
function electronDependencies(electronRoot: string): PackageDependencies {
  const packageName = basename(resolve(electronRoot))
  const installed = readdirSync('/var/db/pkg').filter(entry => entry.startsWith(`${packageName}-`)).sort()
  const [installedPackage] = installed
  if (installedPackage === undefined || installed.length > 1) {
    throw new Error(`freebsd package: expected exactly one installed ${packageName} package, found ${String(installed.length)}`)
  }
  const manifest = JSON.parse(readFileSync(join('/var/db/pkg', installedPackage, '+MANIFEST'), 'utf8')) as {
    deps?: Record<string, { origin?: unknown; version?: unknown }>
  }
  const deps: PackageDependencies = {}
  for (const [name, entry] of Object.entries(manifest.deps ?? {})) {
    if (name === 'pkg') continue
    if (typeof entry.origin !== 'string' || typeof entry.version !== 'string') {
      throw new Error(`freebsd package: the Electron package declares an unreadable dependency on ${name}`)
    }
    deps[name] = { origin: entry.origin, version: entry.version }
  }
  if (Object.keys(deps).length === 0) throw new Error(`freebsd package: ${packageName} declares no runtime dependencies`)
  return deps
}

/**
 * Render the freedesktop desktop entry for the installed application.
 *
 * `StartupWMClass` repeats the application's `desktopName`, which is the identity Electron gives
 * its Linux windows; a desktop environment matches the running window against this entry through
 * it. The scheme handler mirrors the packaged `dsh:` protocol registration.
 * @param packageName - Installed command and icon name.
 * @returns Desktop entry file contents.
 */
function desktopEntry(packageName: string): string {
  return [
    '[Desktop Entry]',
    `Name=${PRODUCT_NAME}`,
    `Comment=${PRODUCT_NAME} desktop application`,
    `Exec=${packageName} %U`,
    'Terminal=false',
    'Type=Application',
    `Icon=${packageName}`,
    'Categories=Development;',
    'MimeType=x-scheme-handler/dsh;',
    `StartupWMClass=${packageName}`,
    'StartupNotify=true',
    '',
  ].join('\n')
}

/** The post-install script refreshing the desktop database and icon cache when those tools exist. */
const POST_INSTALL = `#!/bin/sh
# Refresh the caches the installers of desktop packages usually refresh; both tools may be absent
# on a system without a desktop environment, and neither failure should fail the installation.
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database -q ${PREFIX}/share/applications || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -q -t -f ${PREFIX}/share/icons/hicolor || true
fi
`

/**
 * Stage the installed filesystem tree the package ships.
 *
 * The application keeps its Linux directory layout under `share/<package>`, and the commands are
 * relative symlinks into it, so the launcher resolves its resources exactly as the unpacked build
 * does. The bundled `dsh` launcher is linked as well; it resolves its own symlink chain.
 * @param stage - Root of the staged filesystem tree.
 * @param application - Assembled application directory.
 * @param packageName - Installed command and icon name.
 */
function stageFiles(stage: string, application: string, packageName: string): void {
  const shareRoot = join(stage, PREFIX.slice(1), 'share', packageName)
  cpSync(application, shareRoot, { recursive: true })
  const executable = join(shareRoot, packageName)
  if (!existsSync(executable) || !statSync(executable).isFile()) {
    throw new Error(`freebsd package: ${executable} is missing; the packaged executable name does not match ${packageName}`)
  }
  chmodSync(executable, 0o755)
  const binDir = join(stage, PREFIX.slice(1), 'bin')
  mkdirSync(binDir, { recursive: true })
  symlinkSync(`../share/${packageName}/${packageName}`, join(binDir, packageName))
  const cli = join(shareRoot, 'resources', 'runtime', 'cli', 'bin', 'dsh')
  if (!existsSync(cli)) throw new Error(`freebsd package: ${cli} is missing from the assembled application`)
  symlinkSync(`../share/${packageName}/resources/runtime/cli/bin/dsh`, join(binDir, 'dsh'))
  writeFileSync(join(stage, PREFIX.slice(1), 'share', 'applications', `${packageName}.desktop`), desktopEntry(packageName))
  for (const icon of readdirSync(LINUX_ICONS).sort()) {
    const match = ICON_PATTERN.exec(icon)
    if (match === null) continue
    const size = `${match[1]}x${match[2]}`
    const directory = join(stage, PREFIX.slice(1), 'share', 'icons', 'hicolor', size, 'apps')
    mkdirSync(directory, { recursive: true })
    cpSync(join(LINUX_ICONS, icon), join(directory, `${packageName}.png`))
  }
}

/**
 * Write the package metadata and the file list pkg(8) packs.
 *
 * `pkg create` packs exactly the files its plist names, reading their checksums from the staged
 * tree, so the plist carries every file and symlink under the stage and nothing else; the
 * directories are recreated by the installer and removed by the deinstaller.
 * @param metaRoot - Directory receiving `+MANIFEST` and `+POST_INSTALL`.
 * @param stage - Root of the staged filesystem tree.
 * @param packageName - Installed package name.
 * @param version - Package version.
 * @param deps - Runtime dependency map copied from the Electron package.
 * @param maintainer - Package maintainer.
 * @returns Path of the generated plist file.
 */
function writeMetadata(
  metaRoot: string,
  stage: string,
  packageName: string,
  version: string,
  deps: PackageDependencies,
  maintainer: string,
): string {
  mkdirSync(metaRoot, { recursive: true })
  const manifest = {
    name: packageName,
    version,
    origin: PACKAGE_ORIGIN,
    comment: `${PRODUCT_NAME} desktop application`,
    desc: `${PRODUCT_NAME} desktop application bundling its own dsh runtime.\n\nThe application keeps its bundled Electron runtime and dsh runtime under ${PREFIX}/share/${packageName}.`,
    maintainer,
    www: PRODUCT_URL,
    prefix: PREFIX,
    deps,
  }
  writeFileSync(join(metaRoot, '+MANIFEST'), `${JSON.stringify(manifest, undefined, 2)}\n`)
  writeFileSync(join(metaRoot, '+POST_INSTALL'), POST_INSTALL, { mode: 0o755 })
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else files.push(path.slice(stage.length))
    }
  }
  walk(stage)
  const plist = join(metaRoot, 'files.plist')
  writeFileSync(plist, `${files.join('\n')}\n`)
  return plist
}

/**
 * Run `pkg create` and verify the package it wrote records this name and version.
 * @param stage - Root of the staged filesystem tree.
 * @param metaRoot - Directory holding `+MANIFEST` and the plist.
 * @param plist - File list generated from the stage.
 * @param output - Directory receiving the package file.
 * @param packageName - Installed package name.
 * @param version - Package version.
 * @returns Absolute path of the created package.
 */
function createPackage(stage: string, metaRoot: string, plist: string, output: string, packageName: string, version: string): string {
  rmSync(output, { recursive: true, force: true })
  mkdirSync(output, { recursive: true })
  const result = spawnSync('pkg', ['create', '-r', stage, '-p', plist, '-m', metaRoot, '-o', output], { stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`freebsd package: pkg create exited with ${String(result.status ?? result.signal)}`)
  const created = join(output, `${packageName}-${version}.pkg`)
  if (!existsSync(created)) throw new Error(`freebsd package: pkg create did not write ${created}`)
  const read = spawnSync('tar', ['--zstd', '-xOf', created, '+MANIFEST'], { encoding: 'utf8' })
  if (read.status !== 0) throw new Error(`freebsd package: cannot read back ${created}`)
  const recorded = JSON.parse(read.stdout) as { name?: unknown; version?: unknown }
  if (recorded.name !== packageName || recorded.version !== version) {
    throw new Error(`freebsd package: ${created} records ${String(recorded.name)} ${String(recorded.version)}`)
  }
  return created
}

function main(): void {
  const target = resolveDesktopBuildTarget()
  const { platform, arch } = desktopTargetPlatform(target)
  if (platform !== 'freebsd') throw new Error(`freebsd package: target ${target} is not a FreeBSD target`)
  const buildPaths = resolveDesktopTargetBuildPaths()
  const packageName = process.env.DSH_DESKTOP_FREEBSD_PACKAGE_NAME?.trim() || DEFAULT_PACKAGE_NAME
  const maintainer = process.env.DSH_DESKTOP_FREEBSD_MAINTAINER?.trim() || DEFAULT_MAINTAINER
  const electronRoot = requireSetting('DSH_DESKTOP_FREEBSD_ELECTRON_ROOT')
  const version = requireSetting(DESKTOP_BUILD_VERSION_ENV)
  const application = assembledApplication(buildPaths.artifacts, arch)
  const deps = electronDependencies(electronRoot)
  const root = join(buildPaths.root, 'freebsd-pkg')
  const stage = join(root, 'stage')
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  stageFiles(stage, application, packageName)
  const metaRoot = join(root, 'meta')
  const plist = writeMetadata(metaRoot, stage, packageName, version, deps, maintainer)
  const created = createPackage(stage, metaRoot, plist, join(root, 'out'), packageName, version)
  const artifact = join(buildPaths.artifacts, `${packageName}-${version}-freebsd-${arch}.pkg`)
  rmSync(artifact, { force: true })
  renameSync(created, artifact)
  // The staged tree is a full copy of the application; the package is the artifact to keep.
  rmSync(stage, { recursive: true, force: true })
  process.stdout.write(`freebsd package: wrote ${artifact}\n`)
}

main()
