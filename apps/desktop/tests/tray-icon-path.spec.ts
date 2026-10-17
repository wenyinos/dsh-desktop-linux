import { describe, expect, it } from 'vitest'
import { desktopTrayIconPath } from '../src/tray-icon-path.ts'

describe('desktop tray icon selection', () => {
  it('uses the bitmap each platform can show', () => {
    expect(desktopTrayIconPath('win32', 'C:/app/tray.ico', '/app/tray.png')).toBe('C:/app/tray.ico')
    expect(desktopTrayIconPath('linux', 'C:/app/tray.ico', '/app/tray.png')).toBe('/app/tray.png')
    expect(desktopTrayIconPath('freebsd', 'C:/app/tray.ico', '/app/tray.png')).toBe('/app/tray.png')
  })

  it('leaves the macOS menu bar to the Dock', () => {
    expect(desktopTrayIconPath('darwin', 'C:/app/tray.ico', '/app/tray.png')).toBeUndefined()
  })
})
