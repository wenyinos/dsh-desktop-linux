/** The Office engine presence repairs, exercised against each module's own probe text. */

import { describe, expect, it } from 'vitest'
import { repairConsumerEnginePresenceSource, repairOfficeEnginePresenceSource } from '../scripts/office-engine-presence-fixup.ts'

/** The probe as the kit compiles it in the pinned release. */
const PROBE = 'lstatSync(join(directory, name), { throwIfNoEntry: false }) !== void 0'

/** The same probe as the published provider compiles it from its TypeScript source. */
const CONSUMER_PROBE = 'lstatSync(join(directory, name), { throwIfNoEntry: false }) !== undefined'

/** Kit entry source carrying one probe, in the call form the kit uses. */
const KIT_SOURCE = `export function installedPackageExists(name) {
  return (require.resolve.paths(name) ?? []).some((directory) => ${PROBE});
}`

/** Provider entry source carrying the same probe in its own engine resolver. */
const CONSUMER_SOURCE = `export function createEnginePackageResolver(kitEntry) {
  const fromKit = createRequire(kitEntry)
  return (name) => {
    const installed = (fromKit.resolve.paths(name) ?? []).some((directory) => ${CONSUMER_PROBE})
    if (installed) throw new Error('Installed LibreOfficeKit package is incomplete')
  }
}`

const REPAIRED = '(lstatSync(join(directory, name), { throwIfNoEntry: false }) ?? void 0) !== void 0'

/**
 * Slice the expression a module places after its arrow function.
 * @param source - Module source, before or after the repair.
 * @returns The predicate expression, without the surrounding call parentheses.
 */
function probeExpression(source: string): string {
  const marker = '(directory) => '
  const start = source.indexOf(marker) + marker.length
  expect(start).toBeGreaterThanOrEqual(marker.length)
  let depth = 0
  let index = start
  for (; index < source.length; index += 1) {
    const character = source[index]
    if (character === '(') depth += 1
    else if (character === ')') {
      if (depth === 0) break
      depth -= 1
    }
    else if (depth === 0 && (character === ';' || character === '\n')) break
  }
  return source.slice(start, index)
}

/**
 * Evaluate a probe as it appears in a module.
 * @param source - Module source, before or after the repair.
 * @returns A predicate over the answer `lstatSync` would give.
 */
function probeOf(source: string): (answer: unknown) => boolean {
  const expression = probeExpression(source)
  expect(expression).toContain('lstatSync')
  const evaluate = new Function('lstatSync', 'join', 'directory', 'name', `return (${expression})`) as
    (lstatSync: () => unknown, join: () => string, directory: string, name: string) => boolean
  return answer => evaluate(() => answer, () => 'candidate', 'a', 'b')
}

/**
 * Assert that one repair normalizes the archived answer without disturbing the others.
 * @param repair - The repair under test.
 * @param source - Module source carrying one unmodified probe.
 */
function expectNullCountsAsAbsent(repair: (source: string) => string, source: string): void {
  const repaired = repair(source)
  expect(repaired).toContain(REPAIRED)

  const before = probeOf(source)
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
}

describe('Office engine presence repair', () => {
  it('counts a null answer, which an archive filesystem gives for a missing path, as absent', () => {
    expectNullCountsAsAbsent(repairOfficeEnginePresenceSource, KIT_SOURCE)
  })

  it('refuses a module whose probe is absent, already repaired, or ambiguous', () => {
    expect(() => repairOfficeEnginePresenceSource('const untouched = 1')).toThrow(/expected exactly one/u)
    const repaired = repairOfficeEnginePresenceSource(KIT_SOURCE)
    expect(() => repairOfficeEnginePresenceSource(repaired)).toThrow(/expected exactly one/u)
    expect(() => repairOfficeEnginePresenceSource(`${PROBE}; ${PROBE}`)).toThrow(/found 2/u)
  })
})

describe('Office provider engine presence repair', () => {
  it('counts a null answer as absent for the provider own resolver', () => {
    expectNullCountsAsAbsent(repairConsumerEnginePresenceSource, CONSUMER_SOURCE)
  })

  it('accepts either literal the bundler may emit', () => {
    const voidZero = CONSUMER_SOURCE.replace('!== undefined', '!== void 0')
    expect(repairConsumerEnginePresenceSource(voidZero)).toContain(REPAIRED)
  })

  it('refuses a module whose probe is absent, already repaired, or ambiguous', () => {
    expect(() => repairConsumerEnginePresenceSource('const untouched = 1')).toThrow(/expected exactly one/u)
    const repaired = repairConsumerEnginePresenceSource(CONSUMER_SOURCE)
    expect(() => repairConsumerEnginePresenceSource(repaired)).toThrow(/expected exactly one/u)
    expect(() => repairConsumerEnginePresenceSource(`${CONSUMER_PROBE}; ${CONSUMER_PROBE}`)).toThrow(/found 2/u)
  })
})
