#!/usr/bin/env node
/**
 * GitHub Issues 适配器 —— 对 `gh` CLI 的薄封装。
 *
 * 它自己不发网络请求，只做归一化：
 *   1. 从 labels 推出统一刻度的 severity（GitHub 没有严重程度字段）
 *   2. 把 issue body（markdown）拆成 steps / expected / actual
 *   3. 把 comments 摊平成字符串数组
 *
 * 仓库来源，优先级从高到低：
 *   --project owner/name  >  环境变量 GH_REPO  >  gh 自己的当前目录探测
 *
 * 用法：
 *   export GH_REPO=owner/name
 *   node adapters/github.js check
 *   node adapters/github.js list --filter bug --limit 8
 *   node adapters/github.js show 1024
 *
 * 契约见 ../ADAPTERS.md
 */

const { execFileSync } = require('node:child_process')

// ── 调 gh ───────────────────────────────────────────────────────────
// soft: true —— 失败时返回 { ok: false, error }，不退出进程（check 探活用）
function gh(args, { json = true, soft = false } = {}) {
  let raw
  try {
    raw = execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    if (e.code === 'ENOENT') {
      const msg = '找不到 `gh` 命令。安装：https://cli.github.com/'
      return soft ? { ok: false, error: msg } : fail(msg)
    }
    const err = (e.stderr || e.message || '').trim()
    const msg = /auth|login|credentials/i.test(err)
      ? `gh 未登录或无权限：\n${err}\n  先跑：gh auth login`
      : `gh ${args.join(' ')} 执行失败：\n${err}`
    return soft ? { ok: false, error: err || msg } : fail(msg)
  }

  if (!json) return soft ? { ok: true, data: raw } : raw

  try {
    const data = JSON.parse(raw)
    return soft ? { ok: true, data } : data
  } catch (e) {
    const msg = `解析 gh 输出失败：${e.message}\n${raw.slice(0, 400)}`
    return soft ? { ok: false, error: msg } : fail(msg)
  }
}

function repoArgs(project) {
  const repo = project || process.env.GH_REPO
  return repo ? ['--repo', repo] : []   // 都没有就让 gh 自己按 cwd 探测
}

// ── 归一化 ①：labels → severity ─────────────────────────────────────
// GitHub 没有严重程度字段，只能从 label 猜。覆盖几种常见约定，
// 认不出来一律 3（一般）—— 宁可给个中间值，也不要假装知道。
const SEVERITY_RULES = [
  [1, /^(sev(erity)?[-:\s]?1|s1|p0|priority[-:\s]?(critical|0)|critical|blocker|urgent|致命|崩溃)$/i],
  [2, /^(sev(erity)?[-:\s]?2|s2|p1|priority[-:\s]?(high|1)|high|major|important|严重)$/i],
  [3, /^(sev(erity)?[-:\s]?3|s3|p2|priority[-:\s]?(medium|2)|medium|normal|moderate|一般)$/i],
  [4, /^(sev(erity)?[-:\s]?4|s4|p3|p4|priority[-:\s]?(low|3)|low|minor|trivial|nice-to-have|轻微)$/i],
]

function severityFromLabels(labels) {
  const names = (labels || []).map(l => (typeof l === 'string' ? l : l.name || '').trim())
  for (const [score, re] of SEVERITY_RULES) {
    if (names.some(n => re.test(n))) return score
  }
  return 3
}

// ── 归一化 ②：body → steps / expected / actual ──────────────────────
// GitHub 的 issue 模板通常带 markdown 小标题，优先按标题切；
// 没有标题就退回行内标记词；都没有就整段当 steps、expected 给 null。
const SECTION_MARKERS = {
  steps: /^(steps?\s*(to\s*reproduce)?|reproduction(\s*steps)?|repro(\s*steps)?|to\s*reproduce|how\s*to\s*reproduce|重现步骤|复现步骤|操作步骤|步骤)$/i,
  expected: /^(expected(\s*(behaviou?r|result|outcome))?|what\s*should\s*happen|期望(结果|行为|表现)?|预期(结果|行为|表现)?)$/i,
  actual: /^(actual(\s*(behaviou?r|result|outcome))?|current\s*behaviou?r|what\s*happens|实际(结果|表现)?|当前表现|现象)$/i,
}

// `\**` 出现三次是为了吃掉 markdown 粗体的各种写法：
//   Expected: x   /   **Expected:** x   /   **Expected**: x
// 少了它，expected 会以 "** x" 开头 —— 不报错，但判据里混进了标记符号。
const INLINE_MARKERS = {
  expected: /^[\s\-*>]*\**\s*(expected(\s*(behaviou?r|result))?|期望结果|预期结果|期望|预期|应该)\s*\**\s*[:：]\s*\**\s*/im,
  actual: /^[\s\-*>]*\**\s*(actual(\s*(behaviou?r|result))?|实际结果|实际表现|实际|现象)\s*\**\s*[:：]\s*\**\s*/im,
}

function parseBody(body) {
  const text = stripComments(body || '').trim()
  if (!text) return { steps: '', expected: null, actual: null }

  const bySection = splitBySections(text)
  if (bySection) return bySection

  return splitByInlineMarkers(text)
}

// 去掉 issue 模板留下的 HTML 注释（<!-- 请在下方描述 --> 这类）
function stripComments(s) {
  return String(s).replace(/<!--[\s\S]*?-->/g, '')
}

function splitBySections(text) {
  const lines = text.split('\n')
  const heads = []

  lines.forEach((line, i) => {
    // ## Expected behavior   或   **Expected behavior**
    const m = /^\s*(?:#{1,6}\s+|\*\*)\s*(.+?)\s*(?:\*\*)?\s*:?\s*$/.exec(line)
    if (!m) return
    const title = m[1].replace(/[*#:：]/g, '').trim()
    for (const [key, re] of Object.entries(SECTION_MARKERS)) {
      if (re.test(title)) { heads.push({ key, line: i }); break }
    }
  })

  if (!heads.length) return null

  const out = { steps: '', expected: null, actual: null }
  heads.forEach((h, idx) => {
    const end = idx + 1 < heads.length ? heads[idx + 1].line : lines.length
    const body = lines.slice(h.line + 1, end).join('\n').trim()
    if (body) out[h.key] = body
  })

  // 有标题但没匹配到 steps：标题之前的内容当步骤
  if (!out.steps) {
    const head = lines.slice(0, heads[0].line).join('\n').trim()
    out.steps = head || text
  }
  return out
}

function splitByInlineMarkers(text) {
  const find = (re) => {
    const hit = re.exec(text)
    return hit ? { index: hit.index, end: hit.index + hit[0].length } : null
  }
  const exp = find(INLINE_MARKERS.expected)
  const act = find(INLINE_MARKERS.actual)

  if (!exp) return { steps: text, expected: null, actual: null }

  const first = Math.min(exp.index, act ? act.index : Infinity)
  const steps = text.slice(0, first).trim()

  const expEnd = act && act.index > exp.index ? act.index : text.length
  const expected = text.slice(exp.end, expEnd).trim() || null

  let actual = null
  if (act) {
    const actEnd = exp.index > act.index ? exp.index : text.length
    actual = text.slice(act.end, actEnd).trim() || null
  }

  return { steps: steps || text, expected, actual }
}

// ── list ────────────────────────────────────────────────────────────
function list({ project, filter, limit = 30 }) {
  const issues = gh([
    'issue', 'list',
    ...repoArgs(project),
    '--state', 'open',
    ...(filter ? ['--label', filter] : []),
    '--limit', String(limit),
    '--json', 'number,title,labels,url',
  ])

  return {
    issues: issues
      .map(i => ({
        id: String(i.number),
        title: i.title,
        severity: severityFromLabels(i.labels),
        url: i.url,
      }))
      .sort((a, b) => a.severity - b.severity),   // 1 最严重，排前面
  }
}

// ── show ────────────────────────────────────────────────────────────
function show(id, { project }) {
  if (!id) fail('用法：github.js show <issue-number> [--project owner/name]')

  const i = gh([
    'issue', 'view', String(id),
    ...repoArgs(project),
    '--json', 'number,title,body,state,labels,comments,url',
  ])

  const { steps, expected, actual } = parseBody(i.body)

  return {
    id: String(i.number),
    title: i.title,
    severity: severityFromLabels(i.labels),
    status: i.state ? String(i.state).toLowerCase() : 'open',
    steps,
    expected,        // 拆不出来就是 null —— 绝不编造，见 ADAPTERS.md
    actual,
    comments: (i.comments || []).map(c => stripComments(c.body || '').trim()).filter(Boolean),
    url: i.url,
  }
}

// ── check ───────────────────────────────────────────────────────────
function check({ project }) {
  const auth = gh(['auth', 'status'], { json: false, soft: true })
  if (!auth.ok) fail(`gh 未登录：\n${auth.error}\n  先跑：gh auth login`)

  const repo = project || process.env.GH_REPO || null

  // 探活用 soft，失败也要把「登录是好的、只是仓库不对」这个信息给出来
  const probe = gh([
    'issue', 'list', ...repoArgs(repo),
    '--state', 'open', '--limit', '1', '--json', 'number,title,labels,url',
  ], { soft: true })

  if (!probe.ok) {
    fail(
      `gh 登录正常，但读不到仓库的 issue：\n${probe.error}\n\n` +
      (repo
        ? `  当前指定的仓库：${repo}\n  确认它存在、你有权限、且开启了 Issues。`
        : '  未指定仓库。工作流会在别的目录调用适配器，不能依赖当前目录探测。\n' +
          '  显式设置：export GH_REPO=owner/name')
    )
  }

  const first = (probe.data || [])[0]
  return {
    ok: true,
    adapter: 'github',
    repo: repo || '(cwd 探测成功，但工作流场景仍建议设置 GH_REPO)',
    sample: first
      ? { id: String(first.number), title: first.title, severity: severityFromLabels(first.labels), url: first.url }
      : null,
  }
}

// ── CLI ─────────────────────────────────────────────────────────────
function fail(msg) {
  process.stderr.write(`[github-adapter] ${msg}\n`)
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
      out = show(positional[0], { project: flags.project })
      break
    case 'check':
      out = check({ project: flags.project })
      break
    default:
      fail(`未知命令「${cmd || ''}」。可用：list / show / check`)
  }

  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
}

if (require.main === module) main()

module.exports = { parseBody, severityFromLabels, stripComments }
