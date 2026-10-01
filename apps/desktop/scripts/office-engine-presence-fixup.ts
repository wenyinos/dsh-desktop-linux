/** Repair the Office kit's engine-presence probe so a packaged application can use the WASM engine. */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Directory of the kit inside the runtime's node_modules. */
const KIT_DIRECTORY = join('node_modules', '@deepseek-ai', 'libreoffice-kit')

/**
 * The probe as the kit compiles it: any answer other than `undefined` counts as an installed
 * engine directory.
 */
const PRESENCE_PROBE = 'lstatSync(join(directory, name), { throwIfNoEntry: false }) !== void 0'

/**
 * The same probe with `null` counting as an absent directory.
 *
 * Electron's archive filesystem answers a missing path inside `app.asar` with `null`, where Node
 * answers `undefined`, so the probe as written reports every native engine as installed in a
 * packaged application. The kit then throws an incomplete-installation error instead of falling
 * back to WASM, which is the engine Linux declares. Only the missing-path answer is affected, so
 * the repair leaves a present directory, and every other format, untouched.
 */
const PRESENCE_PROBE_REPAIRED = '(lstatSync(join(directory, name), { throwIfNoEntry: false }) ?? void 0) !== void 0'

/**
 * Rewrite the presence probe so a `null` answer counts as an absent directory.
 * @param source - Contents of the kit's entry module.
 * @returns The module with its presence probe repaired.
 * @throws When the module no longer contains exactly one unmodified probe.
 */
export function repairOfficeEnginePresenceSource(source: string): string {
  const occurrences = source.split(PRESENCE_PROBE).length - 1
  if (occurrences !== 1) {
    throw new Error(`desktop runtime: expected exactly one Office engine presence probe, found ${String(occurrences)}; `
      + 'the kit changed how it detects an installed engine, so review the repair before packaging')
  }
  return source.replace(PRESENCE_PROBE, PRESENCE_PROBE_REPAIRED)
}

/**
 * Repair the probe in a materialized Desktop runtime.
 *
 * The runtime is staged and rewritten before its integrity descriptor is written, so the
 * packaged application records the repaired bytes it actually ships.
 * @param runtimeRoot - Materialized dsh runtime directory.
 * @returns The repaired module path.
 * @throws When the kit module is absent or its probe is not in the expected form.
 */
export function repairOfficeEnginePresence(runtimeRoot: string): string {
  const path = join(runtimeRoot, KIT_DIRECTORY, 'lib', 'index.js')
  const source = readFileSync(path, 'utf8')
  writeFileSync(path, repairOfficeEnginePresenceSource(source))
  return path
}
