export const meta = {
  name: 'batch-fix-bugs-run',
  description: '并行修复一批缺陷：每个 bug 一个 agent 在隔离 worktree 里定位+改代码+自测，再由独立 agent 对抗式复核 diff，产出三分类结果（不 commit/不推送/不回写缺陷系统）',
  phases: [
    { title: 'Fix', detail: '每个 bug 一个 agent：读详情→定位→改→非写型自测' },
    { title: 'Verify', detail: '独立 agent 对抗式复核 diff 是否真修好、有无回归' },
  ],
}

// ── 入参（由 /batch-fix-bugs 命令在主会话里准备好后传入）────────────────
// args = {
//   project:   string,   // 项目名/ID，仅用于展示
//   repoPath:  string,   // 目标本地仓库绝对路径
//   tracker:   string,   // 缺陷系统适配器的调用前缀，如 "node /abs/adapters/zentao.js"
//                        // 契约见 ADAPTERS.md：<tracker> show <id> 输出含 steps / expected
//   bugs: [ { id, title, severity, worktree, branch } ]  // 每个 bug 的隔离 worktree 已由主会话建好
// }
const { project, repoPath, tracker, bugs } = args || {}

if (!bugs || !bugs.length) {
  log('没有传入任何 bug，工作流结束。')
  return { project, repoPath, total: 0, results: [] }
}

if (!tracker) {
  log('缺少 tracker（缺陷系统适配器调用前缀），工作流结束。')
  return { project, repoPath, total: 0, results: [] }
}

// 修复 agent 的结构化产出
const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rootCause: { type: 'string', description: 'bug 的根本原因（一两句话）' },
    filesChanged: { type: 'array', items: { type: 'string' }, description: '改动的文件路径列表；无改动则空数组' },
    diff: { type: 'string', description: 'git -C <worktree> diff 的完整输出；无改动则空串' },
    implementation: { type: 'string', description: '按文件/行号说明改了什么（字符串替换用 "旧"→"新"）' },
    solution: { type: 'string', description: '为什么这么改、放弃了哪些替代方案、风险等级（零/低/需关注）' },
    checksRun: { type: 'string', description: '实际跑了哪些自测（type-check/lint/相关单测）及结果；没跑的写明原因' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: '对修复正确性的置信度' },
    needsHuman: { type: 'boolean', description: '定位不到 / 不确定改得对 / 需产品确认时置 true' },
    reason: { type: 'string', description: 'needsHuman 为 true 时说明原因；否则空串' },
  },
  required: ['rootCause', 'filesChanged', 'diff', 'implementation', 'solution', 'checksRun', 'confidence', 'needsHuman', 'reason'],
}

// 验证 agent 的结构化产出
const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['pass', 'needs-human', 'reject'], description: 'pass=可交人审核合并；needs-human=存疑需人工；reject=明显没修对或有回归' },
    reason: { type: 'string', description: '判断理由（对照重现步骤/期望行为）' },
    regressionRisk: { type: 'string', enum: ['none', 'low', 'medium', 'high', 'unknown'] },
  },
  required: ['verdict', 'reason', 'regressionRisk'],
}

log(`项目「${project}」共 ${bugs.length} 个 bug，开始并行修复（每个 bug 一个隔离 worktree）...`)

// 一 bug 一条独立链：修完立刻进入复核，不等其他 bug（pipeline 无 barrier）
const results = await pipeline(
  bugs,

  // ── Stage 1：修复 ────────────────────────────────────────────────
  (bug) => agent(
    `你是资深工程师，负责修复缺陷 #${bug.id}「${bug.title}」。

你的隔离工作目录（git worktree，已软链 node_modules，只在此目录内改动，用绝对路径）：
${bug.worktree}

步骤：
1. 读缺陷详情（该命令与当前工作目录无关，按原样执行）：
   ${tracker} show ${bug.id}
   输出字段：steps（重现步骤）、expected（期望行为，**可能为 null**）、actual（实际表现）。
2. 理解重现步骤与期望行为。
   **如果 expected 为 null**，说明缺陷单里没写清楚期望是什么，需要你从标题和重现步骤推断；
   推断不出来、或者有多种合理解释时，直接把 needsHuman 置为 true，不要挑一种猜。
3. 在 ${bug.worktree} 内用 grep/read 定位相关代码。
4. 做「最小、聚焦」的修复；不要顺手重构无关代码，不要改与本 bug 无关的文件。
5. 跑非写型自测：优先 type-check、lint、与改动相关的单测（看 package.json 的 scripts）。
   不要跑全量 build —— worktree 间共享同一份 node_modules，build 会写共享缓存造成竞争。
6. 用 \`git -C ${bug.worktree} diff\` 取得完整 diff。

判断准则：如果定位不到代码、不确定改得对、或需要产品/设计确认，就把 needsHuman 置为 true 并在 reason 里说清楚，**不要硬编一个可能错的修复**。宁可交人工，也不要制造假阳性。

只返回结构化结果。diff 字段放 \`git -C ${bug.worktree} diff\` 的完整输出。`,
    { label: `fix:#${bug.id}`, phase: 'Fix', schema: FIX_SCHEMA, agentType: 'claude' }
  ).then(fix => ({ bug, fix })),

  // ── Stage 2：对抗式复核 ──────────────────────────────────────────
  ({ bug, fix }) => {
    // 修复失败 / 标记需人工 / 无有效改动 → 不浪费一个复核 agent
    if (!fix || fix.needsHuman || !fix.diff || !(fix.filesChanged && fix.filesChanged.length)) {
      const reason = !fix
        ? '修复 agent 无返回（中途跳过或失败）'
        : fix.needsHuman
          ? (fix.reason || '修复 agent 主动标记需人工')
          : '修复 agent 未产出有效改动'
      return { bug, fix, verify: { verdict: 'needs-human', reason, regressionRisk: 'unknown' } }
    }
    return agent(
      `对抗式复核一个缺陷修复。默认立场是怀疑：只有证据充分才认可，存疑一律降级。

缺陷 #${bug.id}：${bug.title}
修复 agent 给出的根因：${fix.rootCause}
改动文件：${(fix.filesChanged || []).join(', ')}

diff：
${fix.diff}

先自己读缺陷详情核对期望行为（**不要采信上面转述的根因**，以原始描述为准）：
   ${tracker} show ${bug.id}

如果 expected 为 null，说明缺陷单没写明期望行为——此时你对「是否修好」的判断本身就缺乏依据，
除非从重现步骤能唯一确定期望，否则直接给 needs-human。

回答三点：
1. 这个 diff 是否真的能修好该 bug（对照重现步骤与期望行为）？
2. 有没有引入回归、边界遗漏、破坏其他调用方？必要时在 ${bug.worktree} 里 grep 改动函数的其他调用点。
3. 修复 agent 声称的自测是否真的覆盖了这个改动？（"跑了一个检查" 不等于 "验证了这个改动"）

verdict：pass（可交人审核合并）| needs-human（存疑，需人工确认）| reject（明显没修对或有回归）。
只要有一处说不清就给 needs-human 或 reject，不要放水。`,
      { label: `verify:#${bug.id}`, phase: 'Verify', schema: VERIFY_SCHEMA, agentType: 'claude' }
    ).then(verify => ({ bug, fix, verify }))
  }
)

const clean = results.filter(Boolean)

const pass = clean.filter(r => r.verify && r.verify.verdict === 'pass').length
const human = clean.filter(r => r.verify && r.verify.verdict === 'needs-human').length
const reject = clean.filter(r => r.verify && r.verify.verdict === 'reject').length
log(`完成：✅ 可审核合并 ${pass} · ⚠️ 需人工确认 ${human} · ❌ 没搞定 ${reject}`)

// 交回主会话：由主会话渲染三分类报告，并做后续人工审核/合并/回写
return { project, repoPath, total: bugs.length, results: clean }
