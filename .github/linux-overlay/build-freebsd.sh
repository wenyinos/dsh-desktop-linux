#!/bin/sh
# Build the FreeBSD Desktop package on a FreeBSD host.
#
# The Release (FreeBSD Desktop) workflow starts a FreeBSD virtual machine and runs this script
# inside it: the script installs the build environment, overlays this fork's support onto the
# upstream source archive for the requested tag, builds the application, and copies the finished
# pkg into the workspace. The build tree lives outside the workspace, so only the package travels
# back to the runner.
#
# FreeBSD has no Electron distribution on npm or GitHub Releases. The runtime comes from the
# `electron<major>` package of the FreeBSD port, whose data directory shares the Linux layout;
# the environment below points the packaging scripts at that installed distribution the way the
# FreeBSD ports framework's electron.mk does, and electron-builder assembles the application
# through its Linux path with the distribution as `electronDist`.
#
# Environment, all set by the workflow:
#   DSH_TAG               upstream tag to package, e.g. dsh-v0.2.0-rc.2
#   DSH_VERSION           the same version without the dsh-v prefix
#   DSH_UPSTREAM          upstream repository, owner/name
#   DSH_ELECTRON_URL      FreeBSD Electron package to install
#   DSH_ELECTRON_SHA256   SHA-256 of that package
#   DSH_ELECTRON_VERSION  version that package carries

set -eu

fail() { echo "freebsd build: $*" >&2; exit 1; }
step() { echo; echo "=== $* ==="; }

[ "$(uname -s)" = "FreeBSD" ] || fail "this script runs on the FreeBSD build host"
[ "$(id -u)" -eq 0 ] || fail "run as root; pkg(8) installation and the packaging sequence require it"
[ -n "${GITHUB_WORKSPACE:-}" ] || fail "GITHUB_WORKSPACE must point at the fork checkout"
for name in DSH_TAG DSH_VERSION DSH_UPSTREAM DSH_ELECTRON_URL DSH_ELECTRON_SHA256 DSH_ELECTRON_VERSION; do
  eval "value=\${$name:-}"
  [ -n "$value" ] || fail "$name must be set"
done

export ASSUME_ALWAYS_YES=yes
export DSH_TELEMETRY_DISABLED=1
# The bundled runtime compiles native addons from source here: node-pty publishes no FreeBSD
# prebuild, and node-gyp takes the system Node headers instead of downloading a matching set.
export npm_config_nodedir=/usr/local
# Electron must come from the installed FreeBSD distribution, never a download, and nothing may
# fetch browser binaries during dependency installation.
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1
# electron-builder runs the FreeBSD app-builder package instead of downloading its own binary.
export USE_SYSTEM_APP_BUILDER=true

source_root="$HOME/dsh-freebsd-source"

# Surface the packaging journal when a step fails; it records what each stage did, and the
# machine is discarded when the job ends.
finish() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "freebsd build: exited with $status; recent packaging events follow" >&2
    find "$source_root/apps/desktop/.desktop-build/packaging-runs" -name events.jsonl -exec tail -n 40 {} \; 2>/dev/null || true
  fi
  exit "$status"
}
trap finish EXIT

step "Installing the build environment"
pkg update -f
pkg install -y node24 npm-node24 git python3 gmake app-builder

step "Installing the FreeBSD Electron distribution"
electron_package="/var/tmp/$(basename "$DSH_ELECTRON_URL")"
if [ ! -f "$electron_package" ]; then
  curl -fsSL -o "$electron_package" "$DSH_ELECTRON_URL"
fi
actual=$(sha256 -q "$electron_package")
[ "$actual" = "$DSH_ELECTRON_SHA256" ] \
  || fail "sha256 of $electron_package is $actual, expected $DSH_ELECTRON_SHA256"
pkg install -y "$electron_package"
electron_root="/usr/local/share/electron${DSH_ELECTRON_VERSION%%.*}"
[ -d "$electron_root" ] || fail "the installed Electron distribution is not at $electron_root"

step "Downloading the upstream source archive"
rm -rf "$source_root"
mkdir -p "$source_root"
curl -fsSL -o /var/tmp/dsh-freebsd-upstream.tar.gz \
  "https://github.com/${DSH_UPSTREAM}/archive/refs/tags/${DSH_TAG}.tar.gz"
tar -xzf /var/tmp/dsh-freebsd-upstream.tar.gz -C "$source_root" --strip-components=1

step "Recording the upstream commit"
git init -q "$source_root"
git -C "$source_root" remote add origin "https://github.com/${DSH_UPSTREAM}.git"
git -C "$source_root" fetch -q --depth 1 origin "refs/tags/${DSH_TAG}"
git -C "$source_root" reset --mixed -q FETCH_HEAD
echo "Upstream commit: $(git -C "$source_root" rev-parse HEAD)"

step "Applying the desktop support overlay"
node "$GITHUB_WORKSPACE/.github/linux-overlay/apply.mjs" --source "$GITHUB_WORKSPACE" --target "$source_root"

step "Writing the FreeBSD release settings"
{
  echo "DSH_DESKTOP_APP_ID=com.deepseek.harness"
  echo "DSH_DESKTOP_FREEBSD_MAINTAINER=DeepSeek <support@deepseek.com>"
  echo "DSH_DESKTOP_FREEBSD_PACKAGE_NAME=deepseek-harness"
  echo "DSH_DESKTOP_FREEBSD_ELECTRON_ROOT=$electron_root"
  echo "DSH_DESKTOP_FREEBSD_ELECTRON_VERSION=$DSH_ELECTRON_VERSION"
} > "$source_root/apps/desktop/.env.freebsd"

step "Installing pnpm"
pnpm_version=$(cd "$source_root" && node -p "require('./package.json').packageManager.split('@')[1]")
npm install --global "pnpm@${pnpm_version}"
pnpm --version

step "Installing workspace dependencies"
cd "$source_root"
pnpm install --frozen-lockfile

step "Packaging the FreeBSD application"
pnpm run package:desktop:freebsd:x64

step "Collecting the package"
artifacts="$source_root/apps/desktop/.desktop-build/targets/freebsd-x64/artifacts"
mkdir -p "$GITHUB_WORKSPACE/freebsd-artifacts"
found=0
for file in "$artifacts"/*.pkg; do
  [ -f "$file" ] || continue
  cp "$file" "$GITHUB_WORKSPACE/freebsd-artifacts/"
  found=1
done
[ "$found" -eq 1 ] || fail "no .pkg was produced"
ls -la "$GITHUB_WORKSPACE/freebsd-artifacts"
echo "freebsd build: finished ${DSH_TAG}"
