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
import { dirname, join, resolve } from 'node:path'
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
}
