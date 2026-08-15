#!/usr/bin/env node
/**
 * GitHub 适配器的归一化逻辑测试。
 *
 * 同 zentao.test.js 的理由：parseBody / severityFromLabels 是唯二有真实逻辑、
 * 且会静默出错的地方。expected 拆错了不会报错，只会让复核 Agent
 * 拿着一个错误的验收标准去判断「修好了没有」。
 *
 * 跑：node adapters/github.test.js
 */

const assert = require('node:assert')
const { parseBody, severityFromLabels, stripComments } = require('./github.js')

let passed = 0
const cases = []
const test = (name, fn) => cases.push([name, fn])

// ── severityFromLabels ──────────────────────────────────────────────
test('severity：sev/S 系列', () => {
  assert.strictEqual(severityFromLabels([{ name: 'severity:1' }]), 1)
  assert.strictEqual(severityFromLabels([{ name: 'S2' }]), 2)
  assert.strictEqual(severityFromLabels([{ name: 'sev-4' }]), 4)
})

test('severity：P 系列', () => {
  assert.strictEqual(severityFromLabels([{ name: 'P0' }]), 1)
  assert.strictEqual(severityFromLabels([{ name: 'p1' }]), 2)
  assert.strictEqual(severityFromLabels([{ name: 'P3' }]), 4)
})

test('severity：形容词系列', () => {
  assert.strictEqual(severityFromLabels([{ name: 'critical' }]), 1)
  assert.strictEqual(severityFromLabels([{ name: 'blocker' }]), 1)
  assert.strictEqual(severityFromLabels([{ name: 'major' }]), 2)
  assert.strictEqual(severityFromLabels([{ name: 'trivial' }]), 4)
})

test('severity：中文 label', () => {
  assert.strictEqual(severityFromLabels([{ name: '致命' }]), 1)
  assert.strictEqual(severityFromLabels([{ name: '轻微' }]), 4)
})

test('severity：纯字符串数组也认', () => {
  assert.strictEqual(severityFromLabels(['bug', 'P0']), 1)
})

test('severity：认不出来给 3，不假装知道', () => {
  assert.strictEqual(severityFromLabels([{ name: 'bug' }, { name: 'good first issue' }]), 3)
  assert.strictEqual(severityFromLabels([]), 3)
  assert.strictEqual(severityFromLabels(null), 3)
})

test('severity：多个等级 label 取最严重', () => {
  // 规则表按 1→4 顺序匹配，先命中最严重的
  assert.strictEqual(severityFromLabels([{ name: 'low' }, { name: 'critical' }]), 1)
})

// ── parseBody：markdown 小标题（GitHub issue 模板的标准形态）────────
test('parseBody：## 标题三段', () => {
  const r = parseBody([
    '## Steps to reproduce',
    '1. Open the list page',
    '2. Click back',
    '',
    '## Expected behavior',
    'Filter should be preserved',
    '',
    '## Actual behavior',
    'Filter resets to All',
  ].join('\n'))
  assert.strictEqual(r.steps, '1. Open the list page\n2. Click back')
  assert.strictEqual(r.expected, 'Filter should be preserved')
  assert.strictEqual(r.actual, 'Filter resets to All')
})

test('parseBody：粗体当标题', () => {
  const r = parseBody('**重现步骤**\n1. 点导出\n\n**期望结果**\n只发一次请求')
  assert.strictEqual(r.steps, '1. 点导出')
  assert.strictEqual(r.expected, '只发一次请求')
})

test('parseBody：只有 Expected 标题，前面的算步骤', () => {
  const r = parseBody('点击保存按钮后页面白屏。\n\n### Expected\n应该跳回列表页')
  assert.strictEqual(r.steps, '点击保存按钮后页面白屏。')
  assert.strictEqual(r.expected, '应该跳回列表页')
})

test('parseBody：英式拼写 behaviour 也认', () => {
  const r = parseBody('## Repro\n1. x\n\n## Expected behaviour\ny')
  assert.strictEqual(r.expected, 'y')
})

// ── parseBody：无标题，退回行内标记词 ───────────────────────────────
test('parseBody：行内标记词', () => {
  const r = parseBody('1. 缩小窗口到 375px\n期望：金额完整展示\n实际：溢出容器')
  assert.strictEqual(r.steps, '1. 缩小窗口到 375px')
  assert.strictEqual(r.expected, '金额完整展示')
  assert.strictEqual(r.actual, '溢出容器')
})

test('parseBody：Expected: 行内英文', () => {
  const r = parseBody('Click the button twice.\nExpected: only one request')
  assert.strictEqual(r.expected, 'only one request')
})

// 这几条是拿 cli/cli 的真实 issue 跑出来发现的：粗体标记没吃干净，
// expected 会以 "** " 开头。不报错，但判据里混进了 markdown 符号。
test('parseBody：**Expected:** 粗体包冒号', () => {
  const r = parseBody('Do the thing.\n**Expected:** it should work')
  assert.strictEqual(r.expected, 'it should work')
})

test('parseBody：**Expected**: 冒号在粗体外', () => {
  const r = parseBody('Do the thing.\n**Expected**: it should work')
  assert.strictEqual(r.expected, 'it should work')
})

test('parseBody：粗体形式的 actual 同样不留残渣', () => {
  const r = parseBody('Do it.\n**Expected:** works\n**Actual:** crashes')
  assert.strictEqual(r.expected, 'works')
  assert.strictEqual(r.actual, 'crashes')
})

// ── parseBody：最危险的分支 ─────────────────────────────────────────
test('parseBody：什么标记都没有 → expected 必须是 null，绝不编造', () => {
  const r = parseBody('点了按钮没反应，很奇怪')
  assert.strictEqual(r.expected, null, 'expected 被编出来了，这是最危险的失败模式')
  assert.strictEqual(r.steps, '点了按钮没反应，很奇怪')
})

test('parseBody：模板注释被剥掉后为空 → 不炸', () => {
  const r = parseBody('<!-- 请在下面描述问题 -->\n\n<!-- 期望行为 -->')
  assert.deepStrictEqual(r, { steps: '', expected: null, actual: null })
})

test('parseBody：空 / null 输入', () => {
  assert.deepStrictEqual(parseBody(''), { steps: '', expected: null, actual: null })
  assert.deepStrictEqual(parseBody(null), { steps: '', expected: null, actual: null })
})

test('parseBody：标题下内容为空 → 该字段保持 null', () => {
  const r = parseBody('## Steps\n1. a\n\n## Expected behavior\n\n## Actual behavior\nboom')
  assert.strictEqual(r.expected, null)
  assert.strictEqual(r.actual, 'boom')
})

// ── stripComments ───────────────────────────────────────────────────
test('stripComments：去掉 HTML 注释', () => {
  assert.strictEqual(stripComments('a<!-- hidden -->b'), 'ab')
  assert.strictEqual(stripComments('a<!--\nmulti\nline\n-->b'), 'ab')
})

// ── run ─────────────────────────────────────────────────────────────
for (const [name, fn] of cases) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`)
  }
}

console.log(`\n${passed}/${cases.length} passed`)
process.exit(passed === cases.length ? 0 : 1)
