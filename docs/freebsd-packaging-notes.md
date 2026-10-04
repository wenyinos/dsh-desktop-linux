# FreeBSD packaging notes

English | [中文](freebsd-packaging-notes.zh.md)

How the FreeBSD desktop package is built, and every sharp edge this fork hit while getting
there. Read this before changing anything under the FreeBSD packaging path.

## What ships

`deepseek-harness-<version>-freebsd-x64.pkg` is a native FreeBSD package, not a repackaged
Linux one. It installs under `/usr/local`:

- `/usr/local/share/deepseek-harness/` — the application assembled by electron-builder
  (FreeBSD Electron runtime + `app.asar` + `resources/`)
- `/usr/local/bin/deepseek-harness` — symlink to the application executable
- `/usr/local/bin/dsh` — symlink to the bundled CLI launcher
- `/usr/local/share/deepseek-harness/deepseek-harness-rg` — ripgrep sidecar (see below)
- `/usr/local/share/applications/deepseek-harness.desktop` and hicolor icons

The package declares its runtime dependencies by copying the dependency map of the installed
`electron44` package, so the installing system resolves exactly the libraries that Electron
was built and tested against.

## How it is built

GitHub's hosted runners have no FreeBSD; the workflow boots a FreeBSD 15.1 virtual machine
with `vmactions/freebsd-vm` and runs `.github/linux-overlay/build-freebsd.sh` inside it. The
script downloads the upstream source archive, applies the same overlay the Linux workflow
uses, and packages with `electron-builder --linux --dir` against the FreeBSD Electron
distribution. The `freebsd-x64` target assembles through electron-builder's Linux path because
the FreeBSD Electron distribution has the Linux directory layout; `apps/desktop/scripts/freebsd-package.ts`
then turns the assembled directory into a pkg(8) package.

The FreeBSD Electron distribution comes from tagattie's FreeBSD-Electron releases
(`electron44-44.3.0-freebsd15-amd64.pkg`), pinned by SHA-256 in the workflow. Bump the URL,
version, and hash together.

## Sharp edges

### The FreeBSD Electron build crashes on self-spawn

Spawning the Electron executable itself with `ELECTRON_RUN_AS_NODE` set kills the caller:
the distribution's embedded startup patch injects crashpad environment into such children,
but the FreeBSD build carries no crashpad support, so the injection throws
`TypeError: t is not a function`. Upstream report: tagattie/FreeBSD-Electron#169.

The fork works around this with `apps/desktop/scripts/node-bin/child-process-hook.cjs`: on
FreeBSD the Node stub loads it with `--require`, and it reroutes exactly those spawns back
through the stub (a shell script, so the patch's `file === process.execPath` check never
fires). The stub covers descendants the same way, so every level stays patched. The Host
launch and the runtime smoke both start through that stub.

### pnpm refuses FreeBSD optional dependencies

Sharp's FreeBSD variant (`@img/sharp-freebsd-wasm32`) exists on the registry and resolves into
the lockfile, but pnpm refuses to link it on FreeBSD (the JavaScript `optionalDependencies`
path filters it; direct dependencies, `file:` overrides and `supportedArchitectures` do not
change that). The runtime loads sharp only when an image conversion runs, so the platform
ships without it and the smoke reports `sharp: false`. The same install also never places a
FreeBSD binding for `node-addon-require-builtin`; the profile resolver reaches those internal
modules through the exposed internal `require` instead.

### npm's `pkg` shadows the system pkg(8)

Inside the build tree, `node_modules/.bin` comes first in `PATH`, and the JavaScript `pkg`
package (a Node bundler) answers to that name. Anything that shells out to `pkg` must use
`/usr/sbin/pkg` (and `/usr/bin/tar`) absolutely, or it runs the wrong tool.

### FreeBSD 15 keeps the package database in SQLite

`/var/db/pkg/<name>-<version>/+MANIFEST` no longer exists; read installed-package metadata
through `pkg query` (for example `pkg query -e '%n = electron44' '%dn %do %dv'`).

### The Office engine set is empty on purpose

The LibreOffice kit declares every engine — including the WASM one — for Linux, macOS, and
Windows only and rejects FreeBSD when an Office feature runs. The runtime therefore ships no
engine, the packaged Host resolves the kit CLI with an explicit `cli: false` (skill reports
"disabled"), and the packaging steps treat the engine closure as empty instead of failing on
a missing directory.

### The ZIP-based assumptions in the build chain

- `node-pty` compiles from source here (it publishes no FreeBSD prebuild), which the fork's
  pnpm patch makes possible by widening its `pty_close_inherited_fds` guard to FreeBSD.
- The runtime install on FreeBSD runs on the host Node instead of the packaged Electron,
  because koffi's install probe spawns the running executable and hits the self-spawn crash.
- The lockfile the Linux workflow builds from is patched in flight (`apply.mjs`): the
  replacement entry manifest and the edited node-pty patch need matching importer entries and
  `patchedDependencies` hashes, and the build tree keeps the upstream lockfile otherwise.

## Verifying a package

```sh
sudo pkg install ./deepseek-harness-<version>-freebsd-x64.pkg
dsh --version   # prints the release version; runs the Electron runtime in Node mode
```

A full check also reads the package back with `pkg info -F` and exercises the desktop smoke
(the workflow does both on every build).

## Current limitations

- No Office conversion: the kit ships no FreeBSD engine (see above).
- No image processing: sharp's FreeBSD variant cannot be installed (see above).
- No Python runtime payload and no sandbox: the workspace-dependency and confinement
  features report unavailable; the bundled Node and pnpm still work.
