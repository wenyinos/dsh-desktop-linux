/** Validate the assembled application, including native Office conversion outside ASAR. */
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { readDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import { verifyWindowsCode } from './windows-runtime-signature.mjs'
import { smokePreparedRuntime } from './smoke-prepared-runtime.ts'
import { resolveDesktopPackageTarget } from './package-target.ts'

const paths = resolveDesktopTargetBuildPaths()
const { values } = parseArgs({ options: { unsigned: { type: 'boolean', default: false } }, allowPositionals: false })
const target = resolveDesktopBuildTarget()
const packaged = resolveDesktopPackageTarget(target)
const windows = target === 'win-x64'
if (values.unsigned && !windows) throw new Error('desktop smoke: unsigned artifacts require Windows')
const artifacts = values.unsigned ? paths.unsignedArtifacts : paths.artifacts

/**
 * Locate the assembled application electron-builder wrote.
 *
 * electron-builder appends the architecture to the unpacked directory for every architecture
 * other than the platform default, so the x64 Linux target lands in `linux-unpacked` while the
 * arm64 target lands in `linux-arm64-unpacked`. macOS names its bundle after the same rule.
 * @returns Absolute path of the directory holding the application's resources.
 */
function assembledApplication(): string {
  if (windows) return join(artifacts, 'win-unpacked')
  if (target === 'mac-arm64') return join(artifacts, 'mac-arm64', 'DeepSeek Harness.app', 'Contents')
  if (target === 'mac-x64') return join(artifacts, 'mac', 'DeepSeek Harness.app', 'Contents')
  return join(artifacts, packaged.arch === 'x64' ? 'linux-unpacked' : `linux-${packaged.arch}-unpacked`)
}

const application = assembledApplication()
const resources = join(application, windows || target.startsWith('linux-') ? 'resources' : 'Resources')
// Linux keeps the packaged executable beside the resources directory under the Electron binary name.
const executable = windows ? join(application, 'DeepSeek Harness.exe')
  : target.startsWith('linux-') ? join(application, 'deepseek-harness')
    : join(application, 'MacOS', 'DeepSeek Harness')
const descriptor = await verifyDesktopRuntime(paths.dsh, readDesktopRuntime(paths.dsh).release.version, packaged)
if (windows && !values.unsigned) await verifyWindowsCode(application)
await smokePreparedRuntime(join(resources, 'app.asar', 'dsh'), executable, join(resources, 'runtime'), descriptor)
