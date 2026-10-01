/**
 * Compose the release notes for a Linux desktop package release.
 *
 * The notes name the upstream tag the packages were built from, give the install command for
 * each distribution family and architecture, and state the two properties a reader has to know
 * before installing: the packages are unsigned, and they carry no automatic update. Keeping the
 * text in one function keeps every release page consistent and lets a test assert it.
 *
 * Plain JavaScript on purpose: the publishing job runs it before the workspace has dependencies.
 */

/** Architectures every release carries, and the package suffix naming each one. */
const ARCHITECTURES = [
  { name: 'x64', deb: 'amd64', rpm: 'x86_64' },
  { name: 'arm64', deb: 'arm64', rpm: 'aarch64' },
]

/**
 * Name the files for both architectures and the command that installs them.
 * @param {'deb' | 'rpm'} format - Package format the command installs.
 * @param {string} version - Release version without a leading `v`.
 * @returns {string} A paragraph with the file names and a shell command.
 */
function installInstructions(format, version) {
  const names = ARCHITECTURES.map(architecture => `deepseek-harness-${version}-linux-${architecture[format]}.${format}`)
  const example = names[0]
  const command = format === 'deb' ? `sudo apt install ./${example}` : `sudo dnf install ./${example}`
  return `\`${names.join('` and `')}\`

\`\`\`sh
${command}
\`\`\``
}

/**
 * Compose the release notes body.
 * @param {object} release - Release identity.
 * @param {string} release.tag - Upstream tag the packages were built from.
 * @param {string} release.version - Release version without a leading `v`.
 * @param {string} release.repository - `owner/name` of the upstream project.
 * @param {string} release.fork - `owner/name` of this packaging repository.
 * @returns {string} Markdown body for the GitHub release.
 */
export function releaseNotes({ tag, version, repository, fork }) {
  const upstream = `https://github.com/${repository}`
  const self = `https://github.com/${fork}`
  return `## 下载 / Downloads

本仓库只发布 Linux 桌面安装包。源码、其它平台版本与项目文档见[上游仓库](${upstream})。

Debian / Ubuntu：

${installInstructions('deb', version)}

Fedora / RHEL / openSUSE：

${installInstructions('rpm', version)}

安装后从应用菜单启动，或在终端运行 \`deepseek-harness\`。捆绑的 \`dsh\` 命令行未加入 \`PATH\`，完整路径为 \`"/opt/DeepSeek Harness/resources/runtime/cli/bin/dsh"\`。

## 本次更新 / What's new

由上游 [\`${tag}\`](${upstream}/releases/tag/${tag}) 的源码压缩包构建，并应用本仓库的 [Linux 支持文件](${self}/blob/master/.github/linux-overlay/manifest.json)。上游源码未经修改。

## 关于这个版本 / About this build

- 安装包未签名，首次安装时系统可能提示来源未知。
- Linux 包通过系统包管理器分发，不包含应用内自动更新；升级请安装新版本包。
- 菜单栏的「安装 dsh 命令」仅在 macOS 与 Windows 提供，Linux 包没有该入口；插件管理不受影响，可在应用内正常使用。
- 由 [${fork}](${self}/actions/workflows/release-desktop-linux.yml) 自动构建。

**完整变更 / Full Changelog**：[${tag}](${upstream}/releases/tag/${tag})
`
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  const [tag, version, repository, fork] = process.argv.slice(2)
  if (tag === undefined || version === undefined || repository === undefined || fork === undefined) {
    throw new Error('release notes: expected <tag> <version> <upstream repository> <fork repository>')
  }
  process.stdout.write(releaseNotes({ tag, version, repository, fork }))
}
