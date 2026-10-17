/** Icon the desktop tray shows, which differs by platform and by development or packaged layout. */

/**
 * Select the tray bitmap for one platform.
 * @param platform - Host platform.
 * @param windowsIcon - Multi-size ICO rendered by `scripts/render-tray-icon.ts`.
 * @param desktopIcon - Launcher bitmap shipped beside the application resources on Linux and FreeBSD.
 * @returns The icon path, or undefined on platforms whose menu bar keeps its own application entry.
 */
export function desktopTrayIconPath(
  platform: NodeJS.Platform,
  windowsIcon: string,
  desktopIcon: string,
): string | undefined {
  if (platform === 'win32') return windowsIcon
  if (platform === 'linux' || platform === 'freebsd') return desktopIcon
  return undefined
}
