/**
 * Put the packaged CLI on `PATH` through the deb and rpm install scripts.
 *
 * A Linux desktop package installs one command, its windowed executable. The bundled `dsh` CLI
 * is present inside the installed tree but not on `PATH`, so it is only reachable by its full
 * path. These scripts add it as `dsh` when the path is free, and remove it again on uninstall.
 *
 * The scripts extend electron-builder's own templates rather than replacing them: those
 * templates enable the sandbox, install an AppArmor profile, and refresh the MIME and desktop
 * databases, and a copy of them here would drift from the builder's on every upgrade. The
 * builder substitutes `${name}` macros in the final file and rejects unknown ones, so the added
 * shell names no variable of its own in that form.
 *
 * JavaScript rather than TypeScript: the electron-builder configuration is loaded as ESM before
 * any build output exists, so it cannot import a TypeScript module.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** Directory inside a target build root that holds the generated scripts. */
export const LINUX_INSTALLER_SCRIPTS_DIRECTORY = 'installer-scripts'

/** Command name the package adds, and where the link is created. */
const COMMAND_NAME = 'dsh'
const COMMAND_LINK = '/usr/bin/dsh'

/** Path of the packaged CLI launcher, expressed with the builder's own product-name macro. */
const CLI_LAUNCHER = '/opt/${sanitizedProductName}/resources/runtime/cli/bin/dsh'

/**
 * Appended to the builder's install script: add the CLI command when the path is free.
 *
 * An existing `/usr/bin/dsh` may belong to another installation, such as an npm-installed CLI,
 * so it is left untouched and the install reports that instead of replacing it. On an upgrade
 * the link this package created is already in place and is left as it is.
 */
const AFTER_INSTALL_ADDITION = `
# Expose the bundled command line interface as ${COMMAND_NAME}.
DSH_CLI_TARGET='${CLI_LAUNCHER}'
if [ -x "$DSH_CLI_TARGET" ]; then
    if [ -L '${COMMAND_LINK}' ] && [ "$(readlink '${COMMAND_LINK}')" = "$DSH_CLI_TARGET" ]; then
        : # This package already provides the command.
    elif [ -e '${COMMAND_LINK}' ] || [ -L '${COMMAND_LINK}' ]; then
        echo "${COMMAND_NAME}: ${COMMAND_LINK} already exists and is not managed here; leaving it unchanged." >&2
    else
        ln -sf "$DSH_CLI_TARGET" '${COMMAND_LINK}'
    fi
fi
`

/**
 * Appended to the builder's removal script: clear the command once its target is gone.
 *
 * Testing the target rather than a removal argument keeps an upgrade intact: during an upgrade
 * the removal script runs after the new version's files are in place, so the launcher still
 * exists and the command is kept. Only a real removal leaves the link dangling.
 */
const AFTER_REMOVE_ADDITION = `
# Clear the command line interface link, but only the one this package created and only once
# the installed launcher it points at is gone.
DSH_CLI_TARGET='${CLI_LAUNCHER}'
if [ -L '${COMMAND_LINK}' ] && [ "$(readlink '${COMMAND_LINK}')" = "$DSH_CLI_TARGET" ] && [ ! -e "$DSH_CLI_TARGET" ]; then
    rm -f '${COMMAND_LINK}'
fi
`

/**
 * Read one of electron-builder's Linux script templates.
 * @param {string} name - Template file name inside the builder's linux template directory.
 * @returns {string} The template source.
 * @throws {Error} When the builder's templates cannot be located.
 */
function builderTemplate(name) {
  const require = createRequire(import.meta.url)
  const manifest = require.resolve('app-builder-lib/package.json')
  return readFileSync(join(dirname(manifest), 'templates', 'linux', name), 'utf8')
}

/**
 * Resolve the install scripts a target build root holds, without writing them.
 * @param {string} buildRoot - Target build root.
 * @returns {{ afterInstall: string, afterRemove: string }} Paths the packaging configuration expects to exist.
 */
export function linuxInstallerScriptPaths(buildRoot) {
  const directory = join(buildRoot, LINUX_INSTALLER_SCRIPTS_DIRECTORY)
  return { afterInstall: join(directory, 'after-install.sh'), afterRemove: join(directory, 'after-remove.sh') }
}

/**
 * Write the deb and rpm install scripts for one target.
 *
 * Both formats read the same pair of scripts; the packages differ in how the shell is invoked,
 * not in what has to happen.
 * @param {string} buildRoot - Target build root that receives the generated scripts.
 * @returns {{ afterInstall: string, afterRemove: string }} Paths of the written scripts.
 */
export function prepareLinuxInstallerScripts(buildRoot) {
  const paths = linuxInstallerScriptPaths(buildRoot)
  mkdirSync(dirname(paths.afterInstall), { recursive: true })
  writeFileSync(paths.afterInstall, `${builderTemplate('after-install.tpl')}${AFTER_INSTALL_ADDITION}`)
  writeFileSync(paths.afterRemove, `${builderTemplate('after-remove.tpl')}${AFTER_REMOVE_ADDITION}`)
  return paths
}
