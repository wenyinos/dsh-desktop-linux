/** The Office engine presence repair, exercised against the kit's own probe text. */

import { describe, expect, it } from 'vitest'
import { repairOfficeEnginePresenceSource } from '../scripts/office-engine-presence-fixup.ts'

/** The probe as the kit compiles it in the pinned release. */
const PROBE = 'lstatSync(join(directory, name), { throwIfNoEntry: false }) !== void 0'

/** Kit entry source carrying one probe, in the call form the kit uses. */
const KIT_SOURCE = `export function installedPackageExists(name) {
  return (require.resolve.paths(name) ?? []).some((directory) => ${PROBE});
}`

/**
 * Evaluate a probe as it appears in a module.
 * @param source - Module source, before or after the repair.
 * @returns A predicate over the answer `lstatSync` would give.
 */
function probeOf(source: string): (answer: unknown) => boolean {
  const start = source.indexOf('(directory) => ') + '(directory) => '.length
  const end = source.indexOf(');', start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  const expression = source.slice(start, end)
  const evaluate = new Function('lstatSync', 'join', 'directory', 'name', `return (${expression})`) as
    (lstatSync: () => unknown, join: () => string, directory: string, name: string) => boolean
  return answer => evaluate(() => answer, () => 'candidate', 'a', 'b')
}

describe('Office engine presence repair', () => {
  it('counts a null answer, which an archive filesystem gives for a missing path, as absent', () => {
    const repaired = repairOfficeEnginePresenceSource(KIT_SOURCE)
    expect(repaired).toContain('(lstatSync(join(directory, name), { throwIfNoEntry: false }) ?? void 0) !== void 0')

    const before = probeOf(KIT_SOURCE)
    const after = probeOf(repaired)
    // Node reports a missing path as undefined, and both forms read that as absent.
    expect(before(undefined)).toBe(false)
    expect(after(undefined)).toBe(false)
    // Electron's archive filesystem reports it as null, which only the repair reads as absent.
    expect(before(null)).toBe(true)
    expect(after(null)).toBe(false)
    // A directory that exists is an installed engine either way.
    expect(before({ isDirectory: () => true })).toBe(true)
    expect(after({ isDirectory: () => true })).toBe(true)
  })

  it('refuses a module whose probe is absent, already repaired, or ambiguous', () => {
    expect(() => repairOfficeEnginePresenceSource('const untouched = 1')).toThrow(/expected exactly one/u)
    const repaired = repairOfficeEnginePresenceSource(KIT_SOURCE)
    expect(() => repairOfficeEnginePresenceSource(repaired)).toThrow(/expected exactly one/u)
    expect(() => repairOfficeEnginePresenceSource(`${PROBE}; ${PROBE}`)).toThrow(/found 2/u)
  })
})
