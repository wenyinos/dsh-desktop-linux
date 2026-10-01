/**
 * Verify that the overlay manifest covers every change this fork makes to upstream source.
 *
 * A file the Linux support changes but the manifest omits is not copied over the downloaded
 * upstream archive, and the build then fails on a missing module minutes into packaging. The
 * manifest records the upstream revision it was authored against, so the set of files this fork
 * changed is exactly `git diff <authoredAgainst>`, and comparing the two catches an omission
 * before anything is built.
 *
 * The two README files are listed as exclusions rather than left unmentioned: they document the
 * fork without feeding the build, and an explicit record is what lets the coverage check tell a
 * deliberate omission from a forgotten file.
 *
 * Plain JavaScript on purpose: the workflow runs it against a fresh checkout before the
 * workspace has any dependencies installed.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const OVERLAY_ROOT = dirname(fileURLToPath(import.meta.url))

/**
 * List the paths that differ from one revision, including uncommitted work.
 * @param {string} repositoryRoot - Repository to inspect.
 * @param {string} authoredAgainst - Revision the manifest was authored against.
 * @returns {string[]} Sorted repository-relative paths.
 */
function changedPaths(repositoryRoot, authoredAgainst) {
  const git = args => execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' })
  const committed = git(['diff', '--name-only', authoredAgainst, 'HEAD']).split('\n')
  // Uncommitted work counts too, so the check runs before a commit as well as in CI.
  const working = git(['status', '--porcelain=v1', '--untracked-files=all'])
    .split('\n')
    .map(line => line.length > 3 ? line.slice(3) : '')
    // A rename reports both paths, separated by ` -> `.
    .flatMap(path => path.includes(' -> ') ? path.split(' -> ') : [path])
  return [...new Set([...committed, ...working].filter(path => path !== ''))].sort()
}

/**
 * Compare the manifest against the changes this fork makes to upstream source.
 * @param {object} options - Verification inputs.
 * @param {string} options.repositoryRoot - Repository to inspect.
 * @param {string} [options.manifestPath] - Manifest to read; defaults to this overlay's.
 * @returns {{ listed: string[], excluded: string[], unlisted: string[], stale: string[] }} Paths in
 *   each category. `unlisted` is empty when the manifest is complete.
 */
export function verifyManifestCoverage({ repositoryRoot, manifestPath = join(OVERLAY_ROOT, 'manifest.json') }) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const listed = Object.keys(manifest.files)
  const excluded = Object.keys(manifest.excluded ?? {})
  const declared = new Set([...listed, ...excluded])
  const changed = changedPaths(repositoryRoot, manifest.authoredAgainst)
  const unlisted = changed.filter(path => !declared.has(path))
  // A listed file that no longer differs means the manifest kept an entry whose change was
  // dropped; harmless to copy, but it hides that the entry is obsolete. Exclusions are policy
  // rather than a claim about the current tree, so they are not checked this way.
  const stale = listed.filter(path => !changed.includes(path)).sort()
  return { listed: listed.sort(), excluded: excluded.sort(), unlisted, stale }
}

/**
 * Fail with every path the manifest fails to account for.
 * @param {object} options - Verification inputs, as `verifyManifestCoverage`.
 * @returns {void}
 * @throws {Error} When a changed path is neither listed nor excluded.
 */
export function requireManifestCoverage(options) {
  const { unlisted } = verifyManifestCoverage(options)
  if (unlisted.length === 0) return
  throw new Error([
    `linux overlay: ${String(unlisted.length)} changed path(s) are neither listed nor excluded:`,
    ...unlisted.map(path => `  ${path}`),
    'Add each build input to manifest.json `files`, and each deliberate omission to `excluded`',
    'with the reason, so an automated build receives everything the Linux support needs.',
  ].join('\n'))
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  const repositoryRoot = process.argv[2] ?? process.cwd()
  try {
    const { listed, excluded, stale } = verifyManifestCoverage({ repositoryRoot })
    requireManifestCoverage({ repositoryRoot })
    process.stdout.write(`linux overlay: ${String(listed.length)} listed and ${String(excluded.length)} excluded path(s) cover every change in the repository\n`)
    if (stale.length > 0) {
      process.stdout.write(`::warning title=Overlay lists unchanged paths::${stale.join(', ')}\n`)
    }
  }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
