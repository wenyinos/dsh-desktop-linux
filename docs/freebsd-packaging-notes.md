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

### The Office engine is installed but never unpacked

The kit does not refuse FreeBSD. `platformTarget()` answers `undefined` for every host that
is not Linux, macOS, or Windows, so engine resolution falls through to the WASM package, and
`@deepseek-ai/libreoffice-kit-wasm` declares no `os` or `cpu` — pnpm installs it here like
anywhere else. What this fork declines to do is *use* it: `officePackageDirectories()`
returns an empty set for FreeBSD, so no engine directory ever reaches `asarUnpack`, and the
runtime smoke skips conversion behind a hard-coded platform test.

State the consequence plainly, because an earlier revision of this page claimed the
opposite: the 145 MB of engine assets (a 122 MB `dsoffice.wasm` plus its 22 MB data
archive) are still copied into `app.asar`. They are simply never unpacked and never
exercised — which also means the package pays for them without getting anything back.

### Enabling Office on FreeBSD

Nothing in the dependency graph blocks it, and the engine loader (`assets/dsoffice.cjs`)
requires only `crypto`, `fs`, `os`, `util`, `worker_threads`, and `ws` — no native binding.
Three overlay files keep it off, and all three belong to this fork rather than to upstream:

- `scripts/libreoffice-packages.mjs` — drop the `freebsd` early return so the engine
  directories reach `asarUnpack`. Reading 145 MB out of `app.asar` instead would hold the
  whole archive-backed file in memory.
- `apps/desktop/scripts/prepare-dsh.ts` — drop the `TARGET_PLATFORM !== 'freebsd'` guard so
  the engine is verified on this platform like on every other.
- `apps/desktop/scripts/smoke-runtime.ts` — replace the hard-coded `process.platform` test
  with a real probe, so CI runs a conversion instead of printing that it is unavailable.

The open question is resource use, not support: compiling a 122 MB WASM module in a worker
thread on this Electron build has never been measured. One FreeBSD CI run answers it.

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

## Republishing a FreeBSD build

Releases are republished from this repository; no artifact is ever rebuilt or replaced by
hand:

```sh
gh workflow run release-desktop-linux.yml   --ref master -f force=true
gh workflow run release-desktop-freebsd.yml --ref master -f force=true
```

`force=true` replaces the package a tag already published. Without it the run stops as soon
as it finds an existing FreeBSD package for the tag, which is what the daily schedule relies
on. Leave `tag` empty to package the newest upstream `dsh-vX.Y.Z-rc.N`.

Both workflows publish into the *same* GitHub Release and may run concurrently: one uploads
deb and rpm, the other the pkg, and each replaces only its own assets. A run packages what
the overlay manifest lists, so a fix written into this tree reaches the FreeBSD package
exactly as it reaches the Linux one — no source synchronization step exists or is needed.

## Current limitations

- No Office conversion: the WASM engine is packaged but never unpacked or exercised (see
  above).
- No image processing: sharp's FreeBSD variant cannot be installed (see above).
- No Python runtime payload and no sandbox: the workspace-dependency and confinement
  features report unavailable; the bundled Node and pnpm still work.
