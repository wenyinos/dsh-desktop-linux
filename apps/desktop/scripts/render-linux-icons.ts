/**
 * Render the Linux icon set from `resources/icon.svg`.
 *
 * A Linux package installs its icon into hicolor size directories, and the desktop looks for it
 * only in the sizes the theme's `index.theme` declares. electron-builder names that directory
 * after the bitmap's own edge length, so shipping one large bitmap puts the icon in a directory
 * no theme declares and the launcher shows no icon at all. Each declared size is therefore
 * rasterized from the vector source separately, which keeps edges crisp rather than scaling one
 * large bitmap down.
 *
 * The committed `resources/linux-icons/` directory is the output; rerun
 * `pnpm run render:linux-icons` in `apps/desktop` after changing the vector source.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

/** Edge lengths installed into the hicolor size directories a desktop environment searches. */
export const LINUX_ICON_SIZES = [16, 24, 32, 48, 64, 96, 128, 256, 512] as const

/** Vector source and committed output directory of the Linux icon set. */
export const LINUX_ICON_PATHS = {
  source: fileURLToPath(new URL('../resources/icon.svg', import.meta.url)),
  directory: fileURLToPath(new URL('../resources/linux-icons', import.meta.url)),
} as const

/** Coordinate space of the vector source; sharp's SVG density is scaled against it. */
const SOURCE_EDGE = 1104
const SOURCE_DENSITY = 72

/**
 * Rasterize one square bitmap per requested size.
 * @param svg - Vector source bytes.
 * @param sizes - Edge lengths to render.
 * @returns One file name and its PNG bytes per size, in the requested order.
 */
export async function renderLinuxIcons(
  svg: Buffer,
  sizes: readonly number[] = LINUX_ICON_SIZES,
): Promise<{ name: string; png: Buffer }[]> {
  const icons: { name: string; png: Buffer }[] = []
  for (const size of sizes) {
    icons.push({
      name: `${String(size)}x${String(size)}.png`,
      // Rasterizing from the vector at the target density keeps each size crisp; scaling one
      // large bitmap would soften the small sizes a menu and task bar use.
      png: await sharp(svg, { density: SOURCE_DENSITY * size / SOURCE_EDGE }).resize(size, size).png().toBuffer(),
    })
  }
  return icons
}

async function main(): Promise<void> {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(LINUX_ICON_PATHS.source)
  const icons = await renderLinuxIcons(source)
  // Replace the directory rather than overwrite into it, so a size that is no longer rendered
  // cannot stay behind and contradict the list above.
  await rm(LINUX_ICON_PATHS.directory, { recursive: true, force: true })
  await mkdir(LINUX_ICON_PATHS.directory, { recursive: true })
  for (const icon of icons) await writeFile(join(LINUX_ICON_PATHS.directory, icon.name), icon.png)
  process.stdout.write(`render:linux-icons: wrote ${String(icons.length)} icon(s) to ${LINUX_ICON_PATHS.directory}\n`)
}

if (import.meta.main) await main()
