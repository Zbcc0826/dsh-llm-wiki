/**
 * 把本仓库装进 DSH 的 profile，并打开插件页开关。
 * 不改其他插件的 insert。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)))
const home = process.env.DSH_HOME?.trim()
  ? path.resolve(process.env.DSH_HOME.trim())
  : path.join(homedir(), '.dsh')
const bundleName = 'dsh-llm-wiki'

ensurePeer()

const profiles = path.join(home, 'profiles')
if (!existsSync(profiles)) {
  console.error(`找不到 ${profiles}。先启动一次桌面应用或 dsh，再运行这个脚本。`)
  process.exit(1)
}

const pnpm = findPnpm()
let installed = 0
for (const name of readdirSync(profiles)) {
  const dir = path.join(profiles, name)
  const manifestPath = path.join(dir, 'package.json')
  if (!existsSync(manifestPath)) continue
  linkBundle(dir, pnpm)
  enableBundle(manifestPath)
  installed += 1
  console.log(`已装进 profile ${name}，并打开开关。`)
}

if (installed === 0) {
  console.error('没有可写的 profile。先启动一次桌面应用，再运行这个脚本。')
  process.exit(1)
}

console.log('重启正在运行的桌面应用后，插件页会出现「LLM Wiki」。')

/** 让插件目录自己能找到工具定义。本机已有依赖时直接链接。 */
function ensurePeer() {
  const target = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json')
  if (existsSync(target)) return
  const toolchain = path.resolve(root, '../../.toolchains/dsh/node_modules/@deepseek-ai/dsh-tools')
  if (existsSync(path.join(toolchain, 'package.json'))) {
    mkdirSync(path.join(root, 'node_modules', '@deepseek-ai'), { recursive: true })
    const link = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-tools')
    if (!existsSync(link)) symlinkSync(toolchain, link, 'dir')
    console.log('已链接本机的 @deepseek-ai/dsh-tools。')
    return
  }
  const vendor = path.join(root, '.dsh-deps')
  mkdirSync(vendor, { recursive: true })
  writeFileSync(path.join(vendor, 'package.json'), `${JSON.stringify({ private: true, dependencies: { '@deepseek-ai/dsh-tools': '0.2.2-rc.3' } }, null, 2)}\n`)
  const result = spawnSync('npm', ['install', '--prefix', vendor, '--no-fund', '--no-audit'], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status || 1)
  symlinkSync(path.join(vendor, 'node_modules'), path.join(root, 'node_modules'), 'dir')
}

/** 用桌面应用自带的 pnpm，或 PATH 上的 pnpm。 */
function findPnpm() {
  if (process.env.PNPM_BIN && existsSync(process.env.PNPM_BIN)) return process.env.PNPM_BIN
  const onPath = spawnSync('sh', ['-c', 'command -v pnpm'], { encoding: 'utf8' })
  if (onPath.status === 0 && onPath.stdout.trim()) return onPath.stdout.trim()
  const fromApp = path.join('/Applications/DeepSeek Harness.app', 'Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs')
  if (existsSync(fromApp)) return fromApp
  console.error('找不到 pnpm。')
  process.exit(1)
}

/** 已经指向这个目录时不重复安装。 */
function linkBundle(dir, pnpm) {
  const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const current = manifest.dependencies?.[bundleName] ?? ''
  if (typeof current === 'string' && current.includes(root)) return
  const command = pnpm.endsWith('.mjs') ? process.execPath : pnpm
  const args = pnpm.endsWith('.mjs') ? [pnpm, 'add', `link:${root}`] : ['add', `link:${root}`]
  const result = spawnSync(command, args, { cwd: dir, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status || 1)
}

/** 打开插件页开关，保留已经启用的其他包。 */
function enableBundle(file) {
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  const profile = manifest.dsh?.profile ?? {}
  const bundles = Array.isArray(profile.bundles) ? [...profile.bundles] : []
  if (!bundles.includes(bundleName)) bundles.push(bundleName)
  manifest.dsh = { ...manifest.dsh, profile: { ...profile, bundles } }
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
}
