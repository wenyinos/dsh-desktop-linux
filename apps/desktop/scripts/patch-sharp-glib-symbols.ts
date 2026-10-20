/**
 * Isolate the glib that sharp's prebuilt libvips statically links from the GTK glib Electron loads.
 *
 * `@img/sharp-libvips-linux-*` carries its own glib 2.90, and `@img/sharp-linux-*.node` imports
 * seven glib functions from it. Inside an Electron process the system libgobject is already in the
 * global scope, so those imports bind to the distribution's glib (2.88 on Fedora 44) and finalize
 * GObjects the bundled glib created, which raises SIGSEGV on the first image attachment. Renaming
 * the seven symbols on both binaries keeps the pair on the bundled glib regardless of what the
 * Electron executable has loaded.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Symbols `sharp.node` imports from its bundled glib; the rename keeps both sides paired. */
const GLIB_SYMBOLS = [
  'g_free',
  'g_log_set_handler',
  'g_malloc',
  'g_object_ref',
  'g_object_unref',
  'g_signal_connect_data',
  'g_utf8_validate',
]

/** Prefix of the renamed symbols, so an already patched tree is recognisable without binutils. */
const SYMBOL_PREFIX = 'vipsglib_'

/** The addon and libvips directory names carrying a native Linux prebuild. */
const NATIVE_DIRECTORIES = /^sharp(?:-libvips)?-linux-(?:arm64|x64)$/u

/**
 * Require a patchelf release that can rename dynamic symbols.
 * @returns {string} The patchelf version string.
 */
function requirePatchelf(): string {
  let output
  try {
    output = execFileSync('patchelf', ['--version'], { encoding: 'utf8' }).trim()
  } catch {
    throw new Error('desktop runtime: patchelf is required to isolate sharp\'s bundled glib on Linux')
  }
  const version = output.replace(/^patchelf\s+/u, '')
  const [major = 0, minor = 0] = version.split('.').map(part => Number.parseInt(part, 10) || 0)
  if (major === 0 && minor < 18) {
    throw new Error(`desktop runtime: patchelf ${version} cannot rename dynamic symbols; 0.18 or newer is required`)
  }
  return version
}

/**
 * Rename the bundled glib symbols of one binary.
 * @param {string} binary - Absolute path of the addon or libvips shared object.
 * @param {string} symbolMap - File listing `old new` symbol pairs for patchelf.
 * @param {string} marker - Symbol name that must appear once the rename succeeded.
 * @returns {boolean} Whether the binary changed.
 */
function renameSymbols(binary: string, symbolMap: string, marker: string): boolean {
  if (readFileSync(binary).includes(marker)) return false
  execFileSync('patchelf', ['--rename-dynamic-symbols', symbolMap, binary], { stdio: 'pipe' })
  if (!readFileSync(binary).includes(marker)) {
    throw new Error(`desktop runtime: ${binary} carries none of sharp's bundled glib symbols; update GLIB_SYMBOLS for this sharp release`)
  }
  return true
}

/**
 * Isolate sharp's bundled glib in a prepared desktop runtime tree.
 * @param {string} dshRoot - Root of the prepared `dsh` package tree.
 * @returns {string[]} Absolute paths of the binaries that were patched.
 */
export function patchSharpGlibSymbols(dshRoot: string): string[] {
  const imageRoot = join(dshRoot, 'node_modules', '@img')
  if (!existsSync(imageRoot)) return []
  const directories = readdirSync(imageRoot).filter(name => NATIVE_DIRECTORIES.test(name))
  if (directories.length === 0) return []
  const addonDirectories = directories.filter(name => !name.includes('-libvips-'))
  const libraryDirectories = directories.filter(name => name.includes('-libvips-'))
  if (addonDirectories.length === 0 || libraryDirectories.length === 0) {
    throw new Error(`desktop runtime: sharp prebuilds are incomplete; found ${directories.sort().join(', ')}`)
  }
  requirePatchelf()
  const workDirectory = mkdtempSync(join(tmpdir(), 'dsh-sharp-glib-'))
  try {
    const symbolMap = join(workDirectory, 'symbols.txt')
    writeFileSync(symbolMap, `${GLIB_SYMBOLS.map(name => `${name} ${SYMBOL_PREFIX}${name}`).join('\n')}\n`)
    const marker = `${SYMBOL_PREFIX}g_object_unref`
    const patched: string[] = []
    for (const directory of addonDirectories) {
      const libDirectory = join(imageRoot, directory, 'lib')
      for (const file of readdirSync(libDirectory).filter(name => name.endsWith('.node'))) {
        const binary = join(libDirectory, file)
        if (renameSymbols(binary, symbolMap, marker)) patched.push(binary)
      }
    }
    for (const directory of libraryDirectories) {
      const libDirectory = join(imageRoot, directory, 'lib')
      const binaries = readdirSync(libDirectory).filter(name => name.startsWith('libvips-cpp.so'))
      if (binaries.length === 0) throw new Error(`desktop runtime: ${libDirectory} carries no libvips shared object`)
      for (const file of binaries) {
        const binary = join(libDirectory, file)
        if (renameSymbols(binary, symbolMap, marker)) patched.push(binary)
      }
    }
    return patched
  } finally {
    rmSync(workDirectory, { recursive: true, force: true })
  }
}
