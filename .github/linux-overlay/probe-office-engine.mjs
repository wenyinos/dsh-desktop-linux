/**
 * Report how a packaged Desktop runtime sees a native Office engine name.
 *
 * The Office kit decides between a native engine and WASM by asking whether the engine's
 * package directory exists, and it treats a present directory without a usable manifest as a
 * broken install rather than falling back to WASM. That probe runs against the archive the
 * application actually ships, so a directory inside `app.asar` counts even though the same
 * name is absent from the unpacked tree. This prints every candidate the kit would consult so
 * such a directory can be named instead of inferred.
 *
 * Run it with the Electron binary of an assembled application, so the archive is readable:
 *
 *   ELECTRON_RUN_AS_NODE=1 <app>/deepseek-harness probe-office-engine.mjs <runtime>/.../lib/index.js
 */

import { closeSync, lstatSync, openSync, readdirSync, readSync, readlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** Native engine the kit looks for on a glibc Linux host, before falling back to WASM. */
const DEFAULT_ENGINE = '@deepseek-ai/libreoffice-kit-linux-x64-glibc'

/**
 * Read every path recorded in an ASAR archive index.
 *
 * An archive begins with a small binary preamble followed by a JSON index of the paths it
 * contains. Reading that index directly shows whether a name reached the archive even when no
 * unpacked directory carries it, which is the difference between a filesystem problem and an
 * archive-content problem.
 * @param archivePath - ASAR file to read.
 * @returns Every indexed path, slash-separated.
 */
function asarPaths(archivePath) {
  const handle = openSync(archivePath, 'r')
  try {
    const preamble = Buffer.alloc(16)
    if (readSync(handle, preamble, 0, 16, 0) !== 16) return []
    const headerSize = preamble.readUInt32LE(12)
    if (headerSize <= 0 || headerSize > 64 * 1024 * 1024) return []
    const header = Buffer.alloc(headerSize)
    if (readSync(handle, header, 0, headerSize, 16) !== headerSize) return []
    const index = JSON.parse(header.toString('utf8'))
    const paths = []
    const walk = (node, prefix) => {
      for (const [name, entry] of Object.entries(node.files ?? {})) {
        const path = `${prefix}/${name}`
        paths.push(path)
        if (entry.files !== undefined) walk(entry, path)
      }
    }
    walk(index, '')
    return paths
  }
  finally {
    closeSync(handle)
  }
}

/**
 * Describe one directory entry without following links, matching the kit's presence probe.
 * @param path - Candidate package directory.
 * @returns A short description, or undefined when nothing is present under that name.
 */
function describe(path) {
  let stats
  try {
    // Electron's archive shim answers a missing path with null where Node answers undefined.
    stats = lstatSync(path, { throwIfNoEntry: false })
  }
  catch (error) {
    return `unreadable (${error.code})`
  }
  if (stats === undefined || stats === null) return undefined
  if (stats.isSymbolicLink()) {
    try {
      return `symlink -> ${readlinkSync(path)}`
    }
    catch {
      return 'symlink'
    }
  }
  if (!stats.isDirectory()) return 'file'
  // An empty directory is what makes the kit call the install incomplete.
  try {
    const entries = readdirSync(path)
    return entries.length === 0 ? 'directory (empty)' : `directory (${String(entries.length)} entries)`
  }
  catch {
    return 'directory (unreadable)'
  }
}

function main() {
  const [baseFile, engine = DEFAULT_ENGINE, archive] = process.argv.slice(2)
  if (baseFile === undefined) throw new Error('probe: pass the path of a module inside the packaged runtime')

  // The base file is the kit's own entry, so its ancestors are the package, its scope and that
  // scope's node_modules directory.
  const packageRoot = dirname(dirname(baseFile))
  const scoped = dirname(packageRoot)
  const modules = dirname(scoped)
  console.log(`probe: base module ${baseFile}`)
  console.log(`probe: sibling packages under ${scoped}`)
  try {
    for (const name of readdirSync(scoped).sort()) {
      if (name.includes('libreoffice-kit')) console.log(`  ${name} ${describe(join(scoped, name)) ?? ''}`)
    }
  }
  catch (error) {
    console.log(`  directory unreadable (${error.code})`)
  }

  // The kit decides between a native engine and WASM by testing whether the engine's directory
  // exists along the module search path, treating a directory it cannot load as a broken
  // install. Printing every candidate names the one that decides this.
  const require_ = createRequire(baseFile)
  const candidates = require_.resolve.paths(engine) ?? []
  console.log(`probe: ${String(candidates.length)} candidate directories for ${engine}`)
  let present = 0
  for (const directory of candidates) {
    const candidate = join(directory, engine)
    const description = describe(candidate)
    if (description === undefined) {
      console.log(`  absent  ${candidate}`)
      continue
    }
    present += 1
    console.log(`  PRESENT ${candidate} (${description})`)
    try {
      const entries = readdirSync(candidate)
      console.log(`    entries: ${entries.slice(0, 8).join(', ') || '(none)'}`)
      console.log(`    package.json: ${entries.includes('package.json') ? 'yes' : 'no'}`)
    }
    catch (error) {
      console.log(`    entries unreadable (${error.code})`)
    }
  }
  console.log(`probe: the kit's presence probe would return ${String(present > 0)}`)

  // The engine the kit falls back to must itself be loadable, or the fallback cannot succeed.
  const wasm = `${DEFAULT_ENGINE.slice(0, DEFAULT_ENGINE.lastIndexOf('-linux'))}-wasm`
  const wasmFile = join(scoped, wasm.replace('@deepseek-ai/', ''), 'package.json')
  console.log(`probe: WASM fallback ${wasmFile} (${describe(wasmFile) ?? 'absent'})`)

  // An archive can hold a path that no unpacked directory carries, and the presence probe runs
  // through the archive while the application is packaged.
  if (archive !== undefined) {
    console.log(`probe: archive index of ${archive}`)
    try {
      const paths = asarPaths(archive)
      const engines = new Set()
      for (const path of paths) {
        const match = /libreoffice-kit[a-z0-9._-]*/u.exec(path)
        if (match !== null) engines.add(match[0])
      }
      console.log(`  indexed paths: ${String(paths.length)}`)
      console.log(`  engine names: ${[...engines].sort().join(', ') || '(none)'}`)
    }
    catch (error) {
      console.log(`  archive unreadable (${error instanceof Error ? error.message : String(error)})`)
    }
  }
}

try {
  main()
}
catch (error) {
  console.log(`probe: failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
