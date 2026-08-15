#!/usr/bin/env node
/**
 * Mock 适配器 —— 从本地 fixture 读数据，不依赖任何外部缺陷系统。
 *
 * 用途：
 *   1. 不接真实系统就能跑通整条流水线
 *   2. 改 prompt 时用它做 A/B —— 数据固定，结果可比
 *   3. 验证你新写的适配器输出格式对不对（拿它的输出当参照）
 *
 * 契约见 ../ADAPTERS.md
 */

const fs = require('node:fs')
const path = require('node:path')

const FIXTURES = process.env.MOCK_FIXTURES
  || path.join(__dirname, 'fixtures', 'issues.json')

function loadAll() {
  let raw
  try {
    raw = fs.readFileSync(FIXTURES, 'utf8')
  } catch (e) {
    fail(`读不到 fixture：${FIXTURES}\n${e.message}`)
  }
  try {
    return JSON.parse(raw)
  } catch (e) {
    fail(`fixture 不是合法 JSON：${FIXTURES}\n${e.message}`)
  }
}

function loadProject(project) {
  const all = loadAll()
  const keys = Object.keys(all)
  if (!project) return all[keys[0]] || []
  if (!all[project]) {
    fail(`fixture 里没有项目「${project}」。可用：${keys.join(', ') || '(空)'}`)
  }
  return all[project]
}

// ── list ────────────────────────────────────────────────────────────
function list({ project, filter, limit }) {
  let issues = loadProject(project)

  // mock 的 filter 语义：severity=<n> 只留该严重程度，其余值忽略（不报错，便于透传测试）
  if (filter && filter.startsWith('severity=')) {
    const want = Number(filter.slice('severity='.length))
    issues = issues.filter(i => i.severity === want)
  }

  // 与真实适配器保持一致：severity 升序（1 最严重）
  issues = [...issues].sort((a, b) => a.severity - b.severity)

  if (limit) issues = issues.slice(0, limit)

  return {
    issues: issues.map(i => ({
      id: String(i.id),
      title: i.title,
      severity: i.severity,
      url: i.url,
    })),
  }
}

// ── show ────────────────────────────────────────────────────────────
function show(id, { project }) {
  const issues = project ? loadProject(project) : Object.values(loadAll()).flat()
  const hit = issues.find(i => String(i.id) === String(id))
  if (!hit) fail(`找不到 issue #${id}`)

  return {
    id: String(hit.id),
    title: hit.title,
    severity: hit.severity,
    status: hit.status ?? 'active',
    steps: hit.steps ?? '',
    // 注意 ?? 而不是 ||：expected 为 null 是有意义的值，不能被兜底成空串
    expected: hit.expected ?? null,
    actual: hit.actual ?? null,
    comments: hit.comments ?? [],
    url: hit.url,
  }
}

// ── check ───────────────────────────────────────────────────────────
function check() {
  const all = loadAll()
  const projects = Object.keys(all)
  const total = Object.values(all).flat().length
  return { ok: true, adapter: 'mock', fixtures: FIXTURES, projects, issues: total }
}

// ── CLI ─────────────────────────────────────────────────────────────
function fail(msg) {
  // 错误必须走 stderr —— stdout 只能是纯 JSON，Agent 会直接解析
  process.stderr.write(`[mock-adapter] ${msg}\n`)
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
  const positional = rest.filter(a => !a.startsWith('--') )
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

    case 'show': {
      const id = positional[0]
      if (!id) fail('用法：mock.js show <id> [--project <p>]')
      out = show(id, { project: flags.project })
      break
    }

    case 'check':
      out = check()
      break

    default:
      fail(`未知命令「${cmd || ''}」。可用：list / show / check\n契约见 ADAPTERS.md`)
  }

  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
}

main()
