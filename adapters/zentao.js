#!/usr/bin/env node
/**
 * 禅道适配器 —— 对 zentao-cli 的薄封装。
 *
 * 它自己不发任何网络请求，只做三件归一化的脏活：
 *   1. 清掉 steps 里的 HTML（禅道回传的是富文本）
 *   2. 从 steps 里拆出「期望行为」—— 禅道没有独立字段，全揉在一起
 *   3. 把禅道的 severity 映射到统一刻度（恰好也是 1-4，但别假设永远如此）
 *
 * 用法：
 *   export ZENTAO_CLI=/path/to/zentao-cli.js
 *   node adapters/zentao.js check
 *   node adapters/zentao.js list --project 18 --filter unresolved
 *   node adapters/zentao.js show 1024
 *
 * 契约见 ../ADAPTERS.md
 *
 * ⚠️ 首次使用请先跑 `check`，再跑一次 list/show 用 jq 看看字段对不对。
 *    zentao-cli 的 --json 输出结构可能随版本变化，下面的 pickList/pickBug
 *    做了多种形状的兼容，但不保证覆盖你那个版本。
 */

const { execFileSync } = require('node:child_process')

const CLI = process.env.ZENTAO_CLI

// ── 调用底层 CLI ────────────────────────────────────────────────────
function callCli(args) {
  if (!CLI) {
    fail('未设置环境变量 ZENTAO_CLI。\n  export ZENTAO_CLI=/path/to/zentao-cli.js')
  }
  let raw
  try {
    raw = execFileSync('node', [CLI, ...args, '--json'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,   // bug 列表 + 富文本可能很大
    })
  } catch (e) {
    fail(`zentao-cli 执行失败：node ${CLI} ${args.join(' ')} --json\n${e.stderr || e.message}`)
  }
  // CLI 有时会在 JSON 前面打印一行提示，从第一个 { 或 [ 开始截
  const start = raw.search(/[[{]/)
  if (start < 0) fail(`zentao-cli 没有输出 JSON：\n${raw.slice(0, 400)}`)
  try {
    return JSON.parse(raw.slice(start))
  } catch (e) {
    fail(`解析 zentao-cli 输出失败：${e.message}\n${raw.slice(0, 400)}`)
  }
}

// ── 归一化 ①：清 HTML ───────────────────────────────────────────────
function stripHtml(html) {
  if (!html) return ''
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi, '[图片: $1]')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map(l => l.trimEnd()).join('\n')
    .trim()
}

// ── 归一化 ②：拆出期望行为 ──────────────────────────────────────────
// 禅道把重现步骤和期望结果揉在同一个 steps 字段里，只能靠标记词切。
// 切不出来就返回 null —— 绝不编造，见 ADAPTERS.md 里的说明。
const EXPECTED_MARKERS = [
  '期望结果', '预期结果', '期望表现', '预期表现',
  '期望', '预期', '应该', '正确的表现', '正确表现', '正确结果',
  'expected',
]
const ACTUAL_MARKERS = [
  '实际结果', '实际表现', '当前表现', '现象', '实际', 'actual',
]

function splitSteps(text) {
  if (!text) return { steps: '', expected: null, actual: null }

  const findMarker = (markers) => {
    let best = null
    for (const m of markers) {
      // 标记词后面允许跟 ：: 空格 换行
      const re = new RegExp(`^[\\s\\-*>]*${m}\\s*[:：]?\\s*`, 'im')
      const hit = re.exec(text)
      if (hit && (best === null || hit.index < best.index)) {
        best = { index: hit.index, end: hit.index + hit[0].length }
      }
    }
    return best
  }

  const exp = findMarker(EXPECTED_MARKERS)
  const act = findMarker(ACTUAL_MARKERS)

  if (!exp) return { steps: text.trim(), expected: null, actual: null }

  // 步骤 = 第一个标记之前的部分
  const firstMarker = Math.min(exp.index, act ? act.index : Infinity)
  const steps = text.slice(0, firstMarker).trim()

  // 期望 = expected 标记之后，到下一个标记为止
  const nextAfterExp = act && act.index > exp.index ? act.index : text.length
  const expected = text.slice(exp.end, nextAfterExp).trim() || null

  let actual = null
  if (act) {
    const nextAfterAct = exp.index > act.index ? exp.index : text.length
    actual = text.slice(act.end, nextAfterAct).trim() || null
  }

  return { steps: steps || text.trim(), expected, actual }
}

// ── 归一化 ③：severity ──────────────────────────────────────────────
// 禅道：1 致命 / 2 严重 / 3 一般 / 4 轻微 —— 与契约刻度一致。
// 仍然显式映射一次，别依赖"恰好相同"这种巧合。
function mapSeverity(v) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 1 && n <= 4 ? n : 3
}

// ── 兼容不同版本的 --json 形状 ──────────────────────────────────────
function pickList(data) {
  if (Array.isArray(data)) return data
  for (const k of ['bugs', 'data', 'list', 'items', 'result']) {
    if (Array.isArray(data?.[k])) return data[k]
    if (Array.isArray(data?.[k]?.bugs)) return data[k].bugs
  }
  fail(`认不出 product-bugs 的输出结构，顶层键：${Object.keys(data || {}).join(', ')}\n请按你的 zentao-cli 版本调整 pickList()`)
}

function pickBug(data) {
  const b = data?.bug || data?.data?.bug || data?.data || data
  if (!b || !b.id) {
    fail(`认不出 bug 详情的输出结构，顶层键：${Object.keys(data || {}).join(', ')}\n请按你的 zentao-cli 版本调整 pickBug()`)
  }
  return { bug: b, comments: data?.comments || data?.data?.comments || b.comments || [] }
}

// ── list ────────────────────────────────────────────────────────────
function list({ project, filter, limit }) {
  if (!project) fail('缺少 --project <产品名或ID>')

  const raw = callCli(['product-bugs', project, '--type', filter || 'unresolved', '--all'])
  let bugs = pickList(raw)

  bugs = bugs
    .map(b => ({
      id: String(b.id),
      title: b.title,
      severity: mapSeverity(b.severity),
      url: b.url || undefined,
    }))
    .sort((a, b) => a.severity - b.severity)   // 1 最严重，排前面

  if (limit) bugs = bugs.slice(0, limit)
  return { issues: bugs }
}

// ── show ────────────────────────────────────────────────────────────
function show(id) {
  if (!id) fail('用法：zentao.js show <id>')

  const { bug, comments } = pickBug(callCli(['bug', String(id)]))
  const plain = stripHtml(bug.steps)
  const { steps, expected, actual } = splitSteps(plain)

  return {
    id: String(bug.id),
    title: bug.title,
    severity: mapSeverity(bug.severity),
    status: bug.status || 'active',
    steps,
    expected,          // 拆不出来就是 null，交给 Agent 自己推断并按需标 needs-human
    actual,
    comments: (comments || [])
      .map(c => stripHtml(typeof c === 'string' ? c : (c.comment || c.content || '')))
      .filter(Boolean),
    url: bug.url || undefined,
  }
}

// ── check ───────────────────────────────────────────────────────────
function check({ project }) {
  if (!CLI) fail('未设置 ZENTAO_CLI')
  const probe = project
    ? list({ project, limit: 1 })
    : { issues: [] }
  return {
    ok: true,
    adapter: 'zentao',
    cli: CLI,
    probedProject: project || '(未指定 --project，仅校验了 CLI 路径)',
    sample: probe.issues[0] || null,
  }
}

// ── CLI ─────────────────────────────────────────────────────────────
function fail(msg) {
  process.stderr.write(`[zentao-adapter] ${msg}\n`)
  process.exit(1)
}

function parseFlags(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) { flags[key] = true; continue }
    flags[key] = next
    i++
  }
  return flags
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const positional = rest.filter(a => !a.startsWith('--'))
  const flags = parseFlags(rest)

  let out
  switch (cmd) {
    case 'list':
      out = list({
        project: flags.project,
        filter: flags.filter,
        limit: flags.limit ? Number(flags.limit) : undefined,
      })
      break
    case 'show':
      out = show(positional[0])
      break
    case 'check':
      out = check({ project: flags.project })
      break
    default:
      fail(`未知命令「${cmd || ''}」。可用：list / show / check`)
  }

  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
}

// 只在被直接执行时跑 CLI；被 require 时导出纯函数供测试
if (require.main === module) main()

module.exports = { stripHtml, splitSteps, mapSeverity }
