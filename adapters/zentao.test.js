#!/usr/bin/env node
/**
 * 禅道适配器的归一化逻辑测试。
 *
 * 只测 splitSteps / stripHtml —— 它们是整个适配器里唯一有真实逻辑的部分，
 * 也是唯一会静默出错的部分：expected 拆错了不会报错，
 * 只会让复核 Agent 拿着一个错误的验收标准去判断「修好了没有」。
 *
 * 跑：node adapters/zentao.test.js
 */

const assert = require('node:assert')
const { stripHtml, splitSteps, mapSeverity } = require('./zentao.js')

let passed = 0
const cases = []
const test = (name, fn) => cases.push([name, fn])

// ── stripHtml ───────────────────────────────────────────────────────
test('stripHtml：br / p 转换行', () => {
  assert.strictEqual(stripHtml('<p>第一行</p><p>第二行</p>'), '第一行\n第二行')
  assert.strictEqual(stripHtml('a<br>b<br/>c'), 'a\nb\nc')
})

test('stripHtml：li 转列表项', () => {
  assert.strictEqual(stripHtml('<ul><li>甲</li><li>乙</li></ul>'), '- 甲\n- 乙')
})

test('stripHtml：图片保留 URL（Agent 至少知道这里有张图）', () => {
  assert.match(stripHtml('<img src="https://x/y.png" alt="截图">'), /\[图片: https:\/\/x\/y\.png\]/)
})

test('stripHtml：HTML 实体还原', () => {
  assert.strictEqual(stripHtml('a&nbsp;&amp;&nbsp;b'), 'a & b')
  assert.strictEqual(stripHtml('&lt;div&gt;'), '<div>')
})

test('stripHtml：空值不炸', () => {
  assert.strictEqual(stripHtml(''), '')
  assert.strictEqual(stripHtml(null), '')
  assert.strictEqual(stripHtml(undefined), '')
})

// ── splitSteps ──────────────────────────────────────────────────────
test('splitSteps：标准三段', () => {
  const r = splitSteps('1. 打开列表\n2. 点返回\n期望结果：筛选条件保持不变\n实际结果：被重置为全部')
  assert.strictEqual(r.steps, '1. 打开列表\n2. 点返回')
  assert.strictEqual(r.expected, '筛选条件保持不变')
  assert.strictEqual(r.actual, '被重置为全部')
})

test('splitSteps：实际在前、期望在后', () => {
  const r = splitSteps('1. 点导出\n实际：发了 5 次请求\n期望：只发 1 次')
  assert.strictEqual(r.steps, '1. 点导出')
  assert.strictEqual(r.expected, '只发 1 次')
  assert.strictEqual(r.actual, '发了 5 次请求')
})

test('splitSteps：只有期望没有实际', () => {
  const r = splitSteps('1. 缩小窗口\n预期：金额完整展示')
  assert.strictEqual(r.steps, '1. 缩小窗口')
  assert.strictEqual(r.expected, '金额完整展示')
  assert.strictEqual(r.actual, null)
})

test('splitSteps：没有任何标记词 → expected 必须是 null，绝不编造', () => {
  const r = splitSteps('点了按钮没反应，很奇怪')
  assert.strictEqual(r.expected, null, 'expected 被编出来了，这是最危险的失败模式')
  assert.strictEqual(r.steps, '点了按钮没反应，很奇怪')
})

test('splitSteps：标记词带 markdown 前缀', () => {
  const r = splitSteps('1. 操作\n- 期望结果: 正常展示')
  assert.strictEqual(r.expected, '正常展示')
})

test('splitSteps：标记词出现在正文中间不误伤开头', () => {
  // "应该" 是个宽泛的标记词，这里确保它不会把整段吃掉
  const r = splitSteps('1. 打开页面\n应该看到列表')
  assert.strictEqual(r.steps, '1. 打开页面')
  assert.strictEqual(r.expected, '看到列表')
})

test('splitSteps：空输入', () => {
  const r = splitSteps('')
  assert.deepStrictEqual(r, { steps: '', expected: null, actual: null })
})

test('splitSteps：标记词后面是空的 → null 而不是空串', () => {
  const r = splitSteps('1. 操作\n期望结果：')
  assert.strictEqual(r.expected, null)
})

// ── mapSeverity ─────────────────────────────────────────────────────
test('mapSeverity：合法值透传，非法值兜底为 3', () => {
  assert.strictEqual(mapSeverity(1), 1)
  assert.strictEqual(mapSeverity('4'), 4)
  assert.strictEqual(mapSeverity(0), 3)
  assert.strictEqual(mapSeverity(99), 3)
  assert.strictEqual(mapSeverity(null), 3)
  assert.strictEqual(mapSeverity('高'), 3)
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
