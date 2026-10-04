/** Desktop resource locations and signing-aware verification for the shared runtime builder. */

import { cp } from 'node:fs/promises'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import {
  prepareOfficeSkillAssets,
  preparePrimaryRuntime as preparePayload,
  smokePrimaryRuntime as smokePayload,
} from '../../../scripts/primary-runtime/prepare.ts'
import { parsePrimaryRuntime, workspaceDependencyPaths } from '../../../packages/skill/tool-workspace-dependencies/src/index.ts'
import { resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { scrubWindowsSigningEnvironment } from './windows-sign.mjs'

/**
 * Assemble the FreeBSD payload from the build host's own Node installation.
 *
 * FreeBSD has neither python-build-standalone builds nor a binary wheel set, so this payload
 * carries the Office skill assets and a Node executable copied from the build host, which is
 * what the Office skill launcher runs. The Python components are absent and the workspace
 * dependency tool reports them unavailable when called; no `runtime.json` is written because
 * there is no complete locked payload to describe.
 * @param runtimeRoot - Desktop runtime directory that receives `primary-runtime` and `office-skills`.
 */
async function prepareFreebsdRuntime(runtimeRoot: string): Promise<void> {
  const require = createRequire(import.meta.url)
  const destination = join(runtimeRoot, 'primary-runtime')
  rmSync(destination, { recursive: true, force: true })
  const nodeBin = join(destination, 'dependencies', 'node', 'bin')
  mkdirSync(nodeBin, { recursive: true })
  mkdirSync(join(destination, 'dependencies', 'node', 'node_modules'), { recursive: true })
  writeFileSync(join(destination, 'dependencies', 'node', 'node_modules', 'README.txt'),
    'Reserved for bundled Node packages. pnpm uses its default installation directories.\n')
  cpSync(process.execPath, join(nodeBin, 'node'))
  const pnpmManifest = require.resolve('pnpm')
  await cp(dirname(pnpmManifest), join(destination, 'dependencies', 'pnpm'), { recursive: true, dereference: true })
  await prepareOfficeSkillAssets(
    join(dirname(require.resolve('@deepseek-ai/dsh-skill-office/package.json')), 'assets'),
    join(runtimeRoot, 'office-skills'))
}

/**
 * Prepare Desktop resources for its selected packaging target.
 * @param options - Signed Windows packaging defers execution until its supervised signing stage.
 * @returns Resolves after preparation and, unless deferred, native-target execution checks.
 */
export async function preparePrimaryRuntime(options: { deferSmoke?: boolean } = {}): Promise<void> {
  const paths = resolveDesktopTargetBuildPaths()
  const target = resolveDesktopBuildTarget()
  if (target === 'freebsd-x64') {
    await prepareFreebsdRuntime(paths.runtime)
    return
  }
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  await preparePayload({ target, output: paths.runtime, cache: paths.downloads, version })
  if (!options.deferSmoke) smokePrimaryRuntime(join(paths.runtime, 'primary-runtime'))
}

/**
 * Verify Desktop's complete payload after preparation or platform signing.
 * @param root - Final payload directory, including any platform signatures.
 */
export function smokePrimaryRuntime(root: string): void {
  const manifest = parsePrimaryRuntime(JSON.parse(readFileSync(join(root, 'runtime.json'), 'utf8')))
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) return
  if (Object.keys(manifest.pythonPackages).length === 0) throw new Error('primary runtime: missing Python distribution versions; prepare the payload before running its smoke checks.')
  const entries = workspaceDependencyPaths(root, manifest)
  if (entries.node === undefined || entries.pnpm === undefined) throw new Error('primary runtime: the Desktop payload must declare node and pnpm components.')
  smokePayload(root, scrubWindowsSigningEnvironment(process.env))
}

if (import.meta.main) await preparePrimaryRuntime()
