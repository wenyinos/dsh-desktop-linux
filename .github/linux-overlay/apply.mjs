/**
 * Apply the Linux Desktop support onto a freshly downloaded upstream source tree.
 *
 * This fork carries the Linux packaging support directly, and each release build downloads the
 * upstream source archive for the requested rc tag and copies these files over it. The manifest
 * lists exactly which files that is, so the Linux support stays a reviewable, bounded change
 * instead of a whole-tree merge, and no manual source synchronization is needed.
 *
 * Plain JavaScript on purpose: it runs before the workspace has any dependencies installed.
 */

import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

const OVERLAY_ROOT = dirname(fileURLToPath(import.meta.url))

function sha256(path) {
  try {
    if (!statSync(path).isFile()) return null
  }
  catch {
    return null
  }
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Add the keys this repository contributes to the upstream document, keeping every upstream
 * value.
 *
 * A manifest file whose change is purely additive has to merge rather than replace: the root and
 * desktop manifests carry the release version, and upstream bumps it in every release, so a
 * whole-file replacement would restore the older version and `release:pack` would then refuse a
 * release whose members disagree about it.
 *
 * This adds only keys upstream does not have. It cannot change or remove one, which is what
 * keeps the version and every other upstream value intact. A file needing a changed value
 * belongs back in whole-file replacement, where the drift warning names it.
 * @param {object} upstream - Parsed upstream document.
 * @param {object} local - Parsed document from this repository.
 * @returns {object} The upstream document with this repository's additions.
 */
export function mergeJson(upstream, local) {
  if (!isPlainObject(upstream) || !isPlainObject(local)) return upstream
  const merged = { ...upstream }
  for (const [key, value] of Object.entries(local)) {
    if (!(key in upstream)) merged[key] = value
    else if (isPlainObject(value) && isPlainObject(upstream[key])) merged[key] = mergeJson(upstream[key], value)
  }
  return merged
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Align the build tree's lockfile with the files this overlay replaces.
 *
 * Two regions need it. The overlay replaces the system entry's manifest with one that declares
 * a FreeBSD optional dependency, and pnpm's frozen install refuses a lockfile whose entry
 * importer disagrees with the manifest; that addition is a workspace link with no registry
 * resolution, so the lines this repository's own lockfile carries can be patched in without
 * invalidating anything else the upstream tree locks. Second, a patch file this fork edits (the
 * node-pty FreeBSD compile fix) changes the hash pnpm records in `patchedDependencies`, and it
 * records the patch file's SHA-256, which is computed here from the source tree. The patch is
 * idempotent and refuses to guess when upstream no longer carries the anchors it edits.
 * @param {string} source - This repository's tree, holding the patch files.
 * @param {string} target - Extracted upstream source tree to overlay onto.
 * @returns {{ importers: boolean, patches: string[] }} Regions the call changed, if any.
 */
export function patchLockfile(source, target) {
  const path = join(target, 'pnpm-lock.yaml')
  if (sha256(path) === null) return { importers: false, patches: [] }
  let text = readFileSync(path, 'utf8')
  const untouched = text
  let importers = false
  if (!text.includes('node-addon-system-freebsd-x64')) {
    const specifierAnchor = "      '@deepseek-ai/node-addon-system-darwin-x64':\n"
      + '        specifier: workspace:~\n'
      + '        version: link:../darwin-x64\n'
    const importerAnchor = '  native/system/packages/linux-arm64: {}\n'
    if (!text.includes(specifierAnchor) || !text.includes(importerAnchor)) {
      throw new Error('linux overlay: the lockfile no longer carries the importer anchors the FreeBSD patch edits; reconcile it with upstream')
    }
    text = text
      .replace(specifierAnchor, `${specifierAnchor}      '@deepseek-ai/node-addon-system-freebsd-x64':\n`
        + '        specifier: workspace:~\n'
        + '        version: link:../freebsd-x64\n')
      .replace(importerAnchor, `  native/system/packages/freebsd-x64: {}\n\n${importerAnchor}`)
    importers = true
  }
  const patches = []
  const manifest = JSON.parse(readFileSync(join(OVERLAY_ROOT, 'manifest.json'), 'utf8'))
  for (const file of Object.keys(manifest.files)) {
    if (!file.startsWith('patches/') || !file.endsWith('.patch')) continue
    const hash = sha256(join(source, file))
    if (hash === null) continue
    // The lockfile keys a patch by the dependency it targets: `node-pty@1.2.0-beta.15` for
    // `node-pty@1.2.0-beta.15.patch`, with scoped names flattened with double underscores.
    const key = basename(file, '.patch').replaceAll('__', '/')
    const entry = new RegExp(`^  ${key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}: [0-9a-f]{64}$`, 'mu')
    const match = entry.exec(text)
    if (match === null) {
      throw new Error(`linux overlay: the lockfile has no patchedDependencies entry for ${key}; reconcile it with upstream`)
    }
    const recorded = /: ([0-9a-f]{64})$/u.exec(match[0])?.[1]
    if (recorded === undefined) {
      throw new Error(`linux overlay: the patchedDependencies entry for ${key} carries no hash`)
    }
    if (recorded === hash) continue
    text = text.replace(entry, `  ${key}: ${hash}`)
    // The same hash appears on the importer's version reference and the snapshot key, and pnpm
    // compares all three, so they move together.
    text = text.replaceAll(`patch_hash=${recorded}`, `patch_hash=${hash}`)
    patches.push(file)
  }
  if (text !== untouched) writeFileSync(path, text)
  return { importers, patches }
}

/**
 * Warn when upstream changed a file this support replaces, then copy every listed file.
 *
 * A changed file is a warning rather than a failure: building a newer upstream tag is the
 * normal case here, and the replacement is a complete file, so upstream edits to it are
 * superseded by design. The warning names them anyway, because an upstream fix to one of
 * these files has to be reconciled by hand. A file marked `merge` is the exception: its
 * upstream content is kept and only the keys this repository sets are applied.
 * @param {string} source - This repository's tree, holding the Linux support files.
 * @param {string} target - Extracted upstream source tree to overlay onto.
 * @returns {{ copied: string[], drifted: string[] }} Paths copied and paths upstream had changed.
 */
export function applyOverlay(source, target) {
  const manifest = JSON.parse(readFileSync(join(OVERLAY_ROOT, 'manifest.json'), 'utf8'))
  // A file this support adds must exist in the source tree, or the build would silently compile
  // against a tree that is missing part of the support.
  const absent = Object.keys(manifest.files).filter(path => sha256(join(source, path)) === null)
  if (absent.length > 0) {
    throw new Error([
      `linux overlay: ${String(absent.length)} listed file(s) are missing from ${source}.`,
      ...absent.map(path => `  ${path}`),
      'A file the Linux support adds belongs in the manifest the moment it is added to the repository.',
    ].join('\n'))
  }
  const copied = []
  const drifted = []
  for (const [path, entry] of Object.entries(manifest.files)) {
    const existing = sha256(join(target, path))
    if (entry.base !== null && existing !== null && existing !== entry.base) drifted.push(path)
    if (entry.base === null && existing !== null) drifted.push(path)
    if (entry.base !== null && existing === null) drifted.push(path)
    const destination = join(target, path)
    mkdirSync(dirname(destination), { recursive: true })
    if (entry.merge === true && existing !== null) {
      const upstream = JSON.parse(readFileSync(destination, 'utf8'))
      const local = JSON.parse(readFileSync(join(source, path), 'utf8'))
      writeFileSync(destination, `${JSON.stringify(mergeJson(upstream, local), undefined, 2)}\n`)
    }
    else {
      copyFileSync(join(source, path), destination)
    }
    copied.push(path)
  }
  return { copied, drifted }
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  const { values } = parseArgs({
    allowPositionals: false,
    options: { source: { type: 'string' }, target: { type: 'string' } },
  })
  if (values.source === undefined || values.target === undefined) {
    throw new Error('linux overlay: --source <this repository tree> and --target <upstream tree> are required')
  }
  const result = applyOverlay(resolve(values.source), resolve(values.target))
  process.stdout.write(`linux overlay: applied ${String(result.copied.length)} file(s) onto ${resolve(values.target)}\n`)
  if (result.drifted.length > 0) {
    process.stdout.write(`::warning title=Upstream changed overlaid files::${String(result.drifted.length)} file(s) replaced by this fork also changed upstream; review the replacements against the new upstream source:\n`)
    for (const path of result.drifted) process.stdout.write(`  ${path}\n`)
  }
  const lockfile = patchLockfile(resolve(values.source), resolve(values.target))
  if (lockfile.importers) process.stdout.write('linux overlay: patched the lockfile with the FreeBSD platform package\n')
  if (lockfile.patches.length > 0) process.stdout.write(`linux overlay: recorded the new hash of ${lockfile.patches.join(', ')}\n`)
}
