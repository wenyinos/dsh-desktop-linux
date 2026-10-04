'use strict'
/**
 * FreeBSD Electron build workaround, loaded with `--require` by the Node stub beside this file.
 *
 * The FreeBSD Electron distribution's embedded startup patch injects crashpad environment into
 * children that spawn the executable itself with `ELECTRON_RUN_AS_NODE` set, but that build
 * carries no crashpad support, so the injection crashes the spawn. Rerouting exactly those
 * children to this directory's `node` stub keeps the invocation working: the stub re-execs the
 * path named by `DSH_DESKTOP_NODE_EXECUTABLE` with the same arguments and `ELECTRON_RUN_AS_NODE`
 * set, so the child still runs as Node. The stub's hook covers descendants the same way.
 *
 * Only the public `child_process` entries and the shared `ChildProcess` prototype are wrapped,
 * and only when the child names the running executable.
 */
const { join } = require('node:path')
const childProcess = require('node:child_process')

const stub = join(__dirname, 'node')
const reroute = (original) => function (file, ...rest) {
  if (file === process.execPath) file = stub
  return original.call(this, file, ...rest)
}
for (const name of ['spawn', 'spawnSync', 'exec', 'execFile', 'execFileSync']) {
  const original = childProcess[name]
  if (typeof original === 'function') childProcess[name] = reroute(original)
}

const prototype = childProcess.ChildProcess.prototype
const spawnImplementation = prototype.spawn
prototype.spawn = function (options) {
  if (options !== null && typeof options === 'object' && options.file === process.execPath) {
    options.file = stub
  }
  return spawnImplementation.call(this, options)
}
