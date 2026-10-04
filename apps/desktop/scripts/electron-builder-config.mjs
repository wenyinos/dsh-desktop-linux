import { officePackageDirectories } from '../../../scripts/libreoffice-packages.mjs'
import { X509Certificate } from 'node:crypto'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  resolveDesktopAppId,
  resolveMacOSNotarizationEnvironment,
  resolveMacOSSigningEnvironment,
} from './desktop-release-environment.mjs'
import { notarizeMacOSDiskImageArtifact } from './notarize-macos-disk-images.mjs'
import { verifyMacOSSignatureAfterSign } from './verify-macos-signature.mjs'
import {
  createWindowsTokenSigner,
  installWindowsNsisBootstrapSigner,
  resolveWindowsUpdatePublisher,
  scrubWindowsSigningEnvironment,
} from './windows-sign.mjs'
import { resolveDesktopAutoUpdateConfig } from './desktop-auto-update-environment.mjs'
import { resolveDesktopBuildCommit } from './desktop-build-commit.mjs'
import { resolveDesktopBuildVersion } from './desktop-build-version.mjs'
import { resolveDesktopPolicyEnvironment } from './desktop-policy-environment.mjs'
import { desktopTargetBuildPaths, resolveDesktopBuildTarget } from './desktop-build-paths.mjs'
import { linuxInstallerScriptPaths } from './linux-installer-scripts.mjs'
import { installWindowsDirectoryInstaller } from './windows-directory-installer.mjs'
import { preserveWindowsRuntimeSignature, signWindowsCode } from './windows-runtime-signature.mjs'
import { prepareWindowsAsarUnpack, verifyWindowsAsarUnpack } from './windows-asar-unpack.mjs'
import { recordPackagingEvent } from './packaging-run.mjs'
import {
  resolveMacOSAppUpdateFeed,
  verifyMacOSAppUpdateConfig,
  writeMacOSAppUpdateConfig,
} from './macos-app-update-config.mjs'

/**
 * Create electron-builder configuration from one release environment.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @param {NodeJS.Platform} hostPlatform - Build-host platform used when no explicit target is present.
 * @param {string} hostArch - Build-host architecture used when no explicit target is present.
 * @param {string | undefined} preparedRuntime - Verified private dsh tree for installed-update qualification; ordinary releases use the target tree.
 * @param {string | undefined} preparedRuntimeVersion - Version that private tree declares, which qualification rewrites away from the product version.
 * @returns {object} electron-builder configuration.
 */
export function createElectronBuilderConfig(
  env = process.env,
  hostPlatform = process.platform,
  hostArch = process.arch,
  preparedRuntime = undefined,
  preparedRuntimeVersion = undefined,
) {
  const appId = resolveDesktopAppId(env)
  const targetPlatform = env.DSH_DESKTOP_TARGET_PLATFORM
  const resolvedPlatform = targetPlatform ?? hostPlatform
  const resolvedArch = env.DSH_DESKTOP_TARGET_ARCH ?? hostArch
  if (env.DSH_DESKTOP_UNSIGNED !== undefined && !['0', '1'].includes(env.DSH_DESKTOP_UNSIGNED)) {
    throw new Error('desktop package: DSH_DESKTOP_UNSIGNED must be 0 or 1')
  }
  const unsigned = env.DSH_DESKTOP_UNSIGNED === '1'
  if (unsigned && resolvedPlatform !== 'win32') throw new Error('desktop package: unsigned builds require Windows')
  const packagesMacOS = targetPlatform === 'darwin' || (targetPlatform === undefined && hostPlatform === 'darwin')
  const packagesWindows = resolvedPlatform === 'win32'
  // The FreeBSD target assembles through the Linux path: the FreeBSD Electron distribution has
  // the Linux layout, and the same filters, desktop entry, and icons apply. Only the final
  // package assembly differs, and that runs after electron-builder.
  const packagesLinux = resolvedPlatform === 'linux' || resolvedPlatform === 'freebsd'
  // fpm requires a maintainer and a project URL for deb/rpm metadata; the release settings may
  // override the maintainer, and the package ident defaults to the product's command name.
  const linuxMaintainer = (resolvedPlatform === 'freebsd' ? env.DSH_DESKTOP_FREEBSD_MAINTAINER : env.DSH_DESKTOP_LINUX_MAINTAINER)?.trim() || 'DeepSeek <support@deepseek.com>'
  const linuxPackageName = (resolvedPlatform === 'freebsd' ? env.DSH_DESKTOP_FREEBSD_PACKAGE_NAME : env.DSH_DESKTOP_LINUX_PACKAGE_NAME)?.trim() || 'deepseek-harness'
  // Linux packages ship as deb/rpm through ordinary distribution rather than the managed
  // update feed, so they carry neither a policy service origin nor an app-update.yml.
  const policy = packagesLinux ? undefined : resolveDesktopPolicyEnvironment(env)
  if (resolvedPlatform === 'win32') installWindowsDirectoryInstaller()
  const macOSSigning = packagesMacOS ? resolveMacOSSigningEnvironment(env) : undefined
  if (packagesMacOS) resolveMacOSNotarizationEnvironment(env)
  const buildPaths = desktopTargetBuildPaths(resolveDesktopBuildTarget(env, hostPlatform, hostArch))
  // The deb and rpm install scripts are written before this configuration is read; they add the
  // bundled CLI to PATH, which a Linux package otherwise leaves inside the installed tree. The
  // FreeBSD package installs the command itself, so this stays a Linux-only step.
  const linuxInstallerScripts = resolvedPlatform === 'linux' ? linuxInstallerScriptPaths(buildPaths.root) : {}
  // The kit selects a native engine by testing whether its package directory exists, and it reads
  // any directory it cannot load as a broken native install instead of falling back to WASM. A
  // Linux release declares no native engine, so no such directory may reach the archive: one stray
  // directory there turns a working WASM engine into a startup failure, which the packaged-runtime
  // smoke reproduces. macOS and Windows select the engine their own package already carries.
  // Builder glob rules read braces as single-character wildcards, so each name is spelled out.
  const dshFileFilters = ['**/*', ...packagesLinux ? [
    '!**/@deepseek-ai/libreoffice-kit-darwin-*/**',
    '!**/@deepseek-ai/libreoffice-kit-darwin-*',
    '!**/@deepseek-ai/libreoffice-kit-win32-*/**',
    '!**/@deepseek-ai/libreoffice-kit-win32-*',
    '!**/@deepseek-ai/libreoffice-kit-linux-*/**',
    '!**/@deepseek-ai/libreoffice-kit-linux-*',
  ] : []]
  let primaryRuntimeDestination
  let dshDestination
  let windowsCode = []
  const unpack = ['**/*.{node,dylib,dll,so,exe}', '**/*.so.*', '**/spawn-helper', '**/@vscode/ripgrep-*/bin/rg',
    `**/node_modules/@deepseek-ai/libreoffice-kit-${resolvedPlatform}-${resolvedArch}/**/*`]
  const windowsSigner = packagesWindows && !unsigned
    ? createWindowsTokenSigner({
        certificateFile: env.DSH_DESKTOP_WINDOWS_CER_FILE,
        signTool: env.DSH_DESKTOP_WINDOWS_SIGNTOOL,
        tokenPin: env.DSH_DESKTOP_WINDOWS_TOKEN_PIN,
        keyContainer: env.DSH_DESKTOP_WINDOWS_KEY_CONTAINER,
        preserveSignature: async path => {
          for (const [sourceRoot, destinationRoot] of [[join(buildPaths.runtime, 'primary-runtime'), primaryRuntimeDestination], [buildPaths.dsh, dshDestination]]) {
            if (destinationRoot !== undefined && await preserveWindowsRuntimeSignature(path, {
              sourceRoot, destinationRoot, runDirectory: env.DSH_DESKTOP_PACKAGING_RUN_DIR,
            })) return true
          }
          return false
        },
      })
    : undefined
  if (windowsSigner !== undefined) {
    installWindowsNsisBootstrapSigner({ sign: windowsSigner })
  }
  const update = unsigned || packagesLinux ? undefined : resolveDesktopAutoUpdateConfig(env, resolvedPlatform, resolvedArch)
  if (preparedRuntime !== undefined) buildPaths.dsh = preparedRuntime
  // electron-builder merges extraMetadata into the packaged manifest, so a build version here reaches
  // the artifact names, the update feed, and the installed app.getVersion() the updater compares against.
  const productVersion = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version
  const buildVersion = resolveDesktopBuildVersion(env, productVersion)
  const packaged = resolveDesktopBuildCommit(env)
  return {
    appId,
    protocols: [{ name: 'DeepSeek Harness', schemes: ['dsh'] }],
    extraMetadata: {
      dshDesktopAppId: appId,
      dshMandatoryUpdatePolicy: policy,
      // fpm requires a project URL for deb/rpm metadata, and this manifest declares none.
      ...packagesLinux ? { homepage: 'https://github.com/deepseek-ai/deepseek-harness' } : {},
      ...buildVersion === productVersion ? {} : { version: buildVersion },
      ...packaged === undefined ? {} : { dshBuildCommit: packaged.commit, dshBuildDirty: packaged.dirty },
    },
    productName: 'DeepSeek Harness',
    // Unsigned builds carry their own suffix so a shared file can never pass for a release artifact.
    artifactName: `deepseek-harness-\${version}-\${os}-\${arch}${unsigned ? '-unsigned' : ''}.\${ext}`,
    directories: { output: unsigned ? buildPaths.unsignedArtifacts : buildPaths.artifacts },
    asar: true,
    electronDist: buildPaths.electron,
    electronFuses: { runAsNode: true },
    beforeBuild: async () => {
      if (resolvedPlatform !== 'win32') return true
      await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        fileURLToPath(new URL('./prepare-windows-installer.ps1', import.meta.url)),
        '-OutputDirectory', join(buildPaths.root, 'installer-ui')], {
        env: scrubWindowsSigningEnvironment(env), windowsHide: true,
      })
      if (windowsSigner !== undefined) {
        await windowsSigner({ path: join(buildPaths.root, 'installer-ui', 'window-frame.dll'), hash: 'sha256', isNest: false })
      }
      // A falsy result tells electron-builder to omit its production node_modules collection.
      return true
    },
    files: [
      'lib/main.js',
      'lib/welcome/**/*',
      'lib/preload-app.cjs',
      'lib/preload-mandatory.cjs',
      'lib/preload-platform-account.cjs',
      'lib/preload-update-dialog.cjs',
      'lib/preload-welcome.cjs',
      'renderer/**/*',
      'package.json',
      { from: buildPaths.dsh, to: 'dsh', filter: dshFileFilters },
      // electron-builder excludes a source directory's root node_modules.
      { from: join(buildPaths.dsh, 'node_modules'), to: 'dsh/node_modules', filter: dshFileFilters },
      // The same exclusion from the app directory, so a native engine name cannot reach the
      // archive through any other collection route either. Contents are excluded as well: a
      // copied child would recreate the directory the kit tests for.
      ...packagesLinux ? [
        '!**/@deepseek-ai/libreoffice-kit-darwin-*/**',
        '!**/@deepseek-ai/libreoffice-kit-darwin-*',
        '!**/@deepseek-ai/libreoffice-kit-win32-*/**',
        '!**/@deepseek-ai/libreoffice-kit-win32-*',
        '!**/@deepseek-ai/libreoffice-kit-linux-*/**',
        '!**/@deepseek-ai/libreoffice-kit-linux-*',
      ] : [],
    ],
    asarUnpack: unpack,
    extraResources: [
      { from: buildPaths.runtime, to: 'runtime' },
      // The About panel reads this beside the application resources on every packaged platform.
      // Linux takes the unmodified 1104 px brand asset; macOS and Windows keep their prepared bitmaps.
      { from: fileURLToPath(new URL(packagesLinux ? '../resources/icon.png' : '../resources/icon-windows.png', import.meta.url)), to: 'icon.png' },
      // Windows tray bitmaps; macOS keeps the Dock and ships no menu bar icon.
      ...(packagesWindows ? [{ from: fileURLToPath(new URL('../resources/tray-windows.ico', import.meta.url)), to: 'tray.ico' }] : []),
    ],
    mac: {
      icon: fileURLToPath(new URL('../resources/icon-macos.png', import.meta.url)),
      category: 'public.app-category.developer-tools',
      // macOS matches the application locale against this bundle, not Electron Framework resources.
      extendInfo: { CFBundleLocalizations: ['en', 'zh_CN'] },
      identity: macOSSigning?.signingIdentity,
      forceCodeSigning: true,
      hardenedRuntime: true,
      extendInfo: { NSMicrophoneUsageDescription: 'DeepSeek Harness uses your microphone to transcribe speech into message drafts.' },
      entitlements: fileURLToPath(new URL('./macos-entitlements.plist', import.meta.url)),
      entitlementsInherit: fileURLToPath(new URL('./macos-entitlements.plist', import.meta.url)),
      // ASAR-unpacked native runtime files are pre-signed; PAK resources are sealed by their enclosing bundle.
      signIgnore: ['/Contents/Resources/app\\.asar\\.unpacked/dsh(?:/|$)', '/Contents/Resources/runtime/primary-runtime(?:/|$)', '\\.pak$'],
      notarize: true,
      target: ['dmg', 'zip'],
    },
    dmg: {
      sign: true,
      writeUpdateInfo: false,
    },
    beforePack: async context => {
      const office = await officePackageDirectories(buildPaths.dsh, { platform: resolvedPlatform, arch: resolvedArch })
      const patterns = office.map(directory => `**/${relative(buildPaths.dsh, directory).split(sep).join('/')}/**/*`)
      const existing = context.packager.config.asarUnpack ?? []
      context.packager.config.asarUnpack = [...(typeof existing === 'string' ? [existing] : existing), ...patterns]
      if (packagesWindows) windowsCode = await prepareWindowsAsarUnpack(context, buildPaths.dsh)
      if (windowsSigner !== undefined) {
        primaryRuntimeDestination = join(context.appOutDir, 'resources', 'runtime', 'primary-runtime')
        dshDestination = join(context.appOutDir, 'resources', 'app.asar.unpacked', 'dsh')
      }
      if (policy === undefined) return
      const { resolveDesktopPolicyConfig } = await import('../lib/types/mandatory-update-policy.js')
      resolveDesktopPolicyConfig(policy)
    },
    afterPack: async context => {
      const { verifyDesktopRuntime } = await import('../lib/types/runtime-tree.js')
      const resourcesDir = context.packager.getResourcesDir(context.appOutDir)
      if (resolvedPlatform === 'darwin' && update !== undefined) {
        await writeMacOSAppUpdateConfig(resourcesDir, resolveMacOSAppUpdateFeed(context.packager.config.publish),
          context.packager.appInfo.updaterCacheDirName)
      }
      // electron-builder renames only the main binary, and the search tool resolves its ripgrep
      // sidecar beside that executable, so the FreeBSD sidecar follows the renamed binary.
      if (resolvedPlatform === 'freebsd') {
        const sidecar = join(context.appOutDir, 'electron-rg')
        if (existsSync(sidecar)) renameSync(sidecar, `${join(context.appOutDir, context.packager.executableName ?? 'deepseek-harness')}-rg`)
      }
      // The bundled runtime declares whichever version prepared it: the product version for an ordinary
      // release, and a rewritten one for installed-update qualification.
      await verifyDesktopRuntime(buildPaths.dsh,
        preparedRuntimeVersion ?? productVersion, { platform: resolvedPlatform, arch: resolvedArch })
      // Unsigned Windows builds skip electron-builder's afterSign hook.
      if (packagesWindows && unsigned) await verifyWindowsAsarUnpack(buildPaths.dsh, resourcesDir, windowsCode)
    },
    afterSign: async context => {
      if (windowsSigner !== undefined) {
        await signWindowsCode(context.appOutDir, {
          thumbprint: new X509Certificate(await readFile(env.DSH_DESKTOP_WINDOWS_CER_FILE)).fingerprint.replaceAll(':', ''),
          sign: windowsSigner,
          record: event => recordPackagingEvent(env.DSH_DESKTOP_PACKAGING_RUN_DIR, event),
        })
        await verifyWindowsAsarUnpack(buildPaths.dsh, context.packager.getResourcesDir(context.appOutDir), windowsCode)
      }
      if (context.electronPlatformName !== 'darwin') return
      const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
      if (update !== undefined) {
        await verifyMacOSAppUpdateConfig(appPath, resolveMacOSAppUpdateFeed(context.packager.config.publish),
          context.packager.appInfo.updaterCacheDirName)
      }
      verifyMacOSSignatureAfterSign(context, macOSSigning ?? resolveMacOSSigningEnvironment(env))
    },
    artifactBuildCompleted: artifact => {
      if (!artifact.file.endsWith('.dmg')) return
      return notarizeMacOSDiskImageArtifact(
        artifact,
        env,
        macOSSigning ?? resolveMacOSSigningEnvironment(env),
      )
    },
    win: {
      icon: fileURLToPath(new URL('../resources/icon-windows.png', import.meta.url)),
      forceCodeSigning: !unsigned,
      signtoolOptions: {
        sign: windowsSigner,
        publisherName: windowsSigner === undefined ? undefined : resolveWindowsUpdatePublisher(env.DSH_DESKTOP_WINDOWS_CER_FILE),
        signingHashAlgorithms: ['sha256'],
      },
      target: ['nsis'],
    },
    linux: {
      // electron-builder derives the packaged executable from the package name, which is scoped
      // here (`@deepseek-ai/dsh-desktop`); name it explicitly so the launcher, desktop entry, and
      // packaged-runtime smoke all resolve the same binary.
      executableName: 'deepseek-harness',
      category: 'Development',
      // A directory of sized bitmaps, not one image: the builder installs each file under
      // `hicolor/<its own size>/`, and the desktop searches only the sizes the theme declares.
      // A single large bitmap lands in a directory the theme does not declare, which leaves the
      // launcher with no icon. `pnpm run render:linux-icons` regenerates this set.
      icon: fileURLToPath(new URL('../resources/linux-icons', import.meta.url)),
      // Electron derives its Linux window identity from `desktopName`, and the desktop entry's
      // `StartupWMClass` has to name the same value or a desktop environment cannot associate a
      // running window with the entry: the window keeps a generic icon and a second launcher
      // entry can appear. Without this the class falls back to the product name, which Electron
      // does not use. `desktopName` is `deepseek-harness`, the same value as the executable and
      // the desktop entry's file name.
      syncDesktopName: true,
      maintainer: linuxMaintainer,
      synopsis: 'DeepSeek Harness desktop application',
      description: 'DeepSeek Harness desktop application bundling its own dsh runtime.',
      target: ['deb', 'rpm'],
    },
    deb: {
      packageName: linuxPackageName,
      // Both formats run the same scripts; these put the bundled CLI on PATH as `dsh`.
      ...linuxInstallerScripts,
      // Electron's Chromium sandbox and the bundled runtime need these at runtime.
      depends: ['libgtk-3-0', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6', 'xdg-utils', 'libatspi2.0-0', 'libsecret-1-0'],
    },
    rpm: {
      packageName: linuxPackageName,
      ...linuxInstallerScripts,
      depends: ['gtk3', 'libnotify', 'nss', 'libXScrnSaver', 'libXtst', 'xdg-utils', 'at-spi2-core', 'libsecret'],
    },
    nsis: {
      installerSidebar: join(buildPaths.root, 'installer-ui', 'uninstaller-sidebar.bmp'),
      uninstallerSidebar: join(buildPaths.root, 'installer-ui', 'uninstaller-sidebar.bmp'),
      include: fileURLToPath(new URL('./installer.nsh', import.meta.url)),
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: false,
      installerLanguages: ['en_US', 'zh_CN'],
      differentialPackage: true,
    },
    detectUpdateChannel: false,
    publish: update === undefined ? null : [{ provider: 'generic', url: update.publicUrl, channel: 'nightly' }],
  }
}
