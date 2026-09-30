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
import { copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
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
 * Warn when upstream changed a file this support replaces, then copy every listed file.
 *
 * A changed file is a warning rather than a failure: building a newer upstream tag is the
 * normal case here, and the replacement is a complete file, so upstream edits to it are
 * superseded by design. The warning names them anyway, because an upstream fix to one of
 * these files has to be reconciled by hand.
 * @param {string} source - This repository's tree, holding the Linux support files.
 * @param {string} target - Extracted upstream source tree to overlay onto.
 * @returns {{ copied: string[], drifted: string[] }} Paths copied and paths upstream had changed.
 */
export function applyOverlay(source, target) {
  const manifest = JSON.parse(readFileSync(join(OVERLAY_ROOT, 'manifest.json'), 'utf8'))
  const copied = []
  const drifted = []
  for (const [path, entry] of Object.entries(manifest.files)) {
    const existing = sha256(join(target, path))
    if (entry.base !== null && existing !== null && existing !== entry.base) drifted.push(path)
    if (entry.base === null && existing !== null) drifted.push(path)
    if (entry.base !== null && existing === null) drifted.push(path)
    const destination = join(target, path)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(join(source, path), destination)
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
