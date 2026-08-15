# 缺陷系统适配器（Issue Tracker Adapter）

这套工作流本身不知道你的 bug 存在哪里。它只依赖一个**适配器**——一个满足下面这份契约的可执行程序。

换 Jira / GitHub Issues / GitLab / 禅道，只需要写一个适配器，工作流一行不用改。

---

## 为什么要有这层

最初的版本直接把缺陷系统的 CLI 命令拼进了 Agent 的 prompt 里。这有两个问题，第二个才是真正的原因。

**第一，显而易见的耦合。** 换个缺陷系统就得改 prompt。

**第二，也是更重要的：不同缺陷系统给出的数据形状，和 Agent 需要的形状，不是一回事。**

举个具体的：禅道把「重现步骤」和「期望结果」揉在同一个 `steps` 字段里，值是一段 HTML。而复核 Agent 要判断「这个改动到底修好了没有」，它需要的是一个明确的**期望行为**作为判据——混在 HTML 里的一段自由文本不构成判据。

所以适配器的职责**不是"把命令换一个"，是"把各家的数据规整成 Agent 需要的形状"**：去掉 HTML、拆出期望行为、把各家五花八门的严重程度映射到统一刻度。

> 一层只做转发的抽象是没有价值的。**适配器的价值在于它承担了归一化的脏活。**

---

## 契约

适配器是一个**可执行程序**（任何语言都行，能被 shell 调起来即可），通过 stdout 输出 JSON。

约定：**成功时 stdout 是纯 JSON，退出码 0；失败时错误信息走 stderr，退出码非 0。** stdout 里不能混任何日志——Agent 会直接解析它。

### `list` —— 拉取待修列表

```bash
<adapter> list --project <项目标识> [--filter <过滤类型>] [--limit <n>]
```

输出：

```json
{
  "issues": [
    { "id": "1024", "title": "筛选条件从详情页返回后失效", "severity": 2, "url": "https://..." }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | ✅ | 唯一标识，后续 `show` 用它 |
| `title` | string | ✅ | 一行标题 |
| `severity` | number | ✅ | **统一刻度：1 最严重，4 最轻**。各家的等级由适配器负责映射 |
| `url` | string | | 人工审核时点进去看的链接 |

`--filter` 的取值由各适配器自己定义（禅道是 `unresolved` / `assigntome`，GitHub 可能是 label）。工作流只负责把这个字符串透传过去，**不解释它的含义**。

### `show` —— 读取单条详情

```bash
<adapter> show <id>
```

输出：

```json
{
  "id": "1024",
  "title": "筛选条件从详情页返回后失效",
  "severity": 2,
  "status": "active",
  "steps": "1. 在列表页选中筛选条件「已完成」\n2. 点击任意一条进入详情\n3. 点浏览器返回",
  "expected": "返回后筛选条件应保持为「已完成」",
  "actual": "筛选条件被重置为「全部」",
  "comments": ["复现环境：Chrome 120"],
  "url": "https://..."
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` `title` `severity` | | ✅ | 同上 |
| `steps` | string | ✅ | **纯文本**重现步骤。HTML 必须由适配器清理掉 |
| `expected` | string \| null | ✅ | **期望行为。这是复核环节的判据，最重要的一个字段。** 提取不到时置 `null`，不要编 |
| `status` `actual` `comments` `url` | | | 有就给 |

### `check` —— 自检（可选但建议实现）

```bash
<adapter> check
```

验证配置和鉴权是否正常，正常则退出码 0。用于排查「跑不起来」到底是配置问题还是别的。

---

## `expected` 为什么单独拎出来

这是整份契约里唯一需要适配器**动脑子**的字段，也是最容易偷懒的地方。

复核 Agent 的核心任务是回答「这个 diff 是否真的修好了这个 bug」。它需要一个明确的**验收标准**。

- 有独立字段的系统（部分 Jira 模板、规范填写的缺陷单）：直接映射
- 没有独立字段的系统（禅道的 `steps` 是一整块自由文本）：尽力从文本里提取「期望/应该/预期」之后的内容
- **提取不到就给 `null`**

给 `null` 是完全可以接受的。工作流会在 prompt 里明确告诉 Agent「本条没有明确的期望行为，需要你从标题和重现步骤推断，并在存疑时标记 needs-human」。

**绝对不要为了填满字段而编一个期望行为。** 那会让复核 Agent 拿着一个错误的判据去验收——比没有判据糟糕得多。

> 这跟工作流内部的设计是同一条原则：**给「不知道」留一个位置，比强行填一个值安全。**

---

## 现成的适配器

| 适配器 | 状态 | 说明 |
|---|---|---|
| `adapters/mock.js` | ✅ | 读本地 fixture，**不需要任何外部系统**，用来跑通流程和改 prompt |
| `adapters/github.js` | ✅ | GitHub Issues，包一层 `gh` CLI。从 labels 推 severity、从 markdown body 拆 expected |
| `adapters/zentao.js` | ✅ | 禅道。对 zentao-cli 的薄封装，负责清 HTML、拆 expected、映射 severity |

归一化逻辑都有测试（`*.test.js`），直接 `node adapters/github.test.js` 跑，无需任何依赖。

### mock 适配器

```bash
node adapters/mock.js list --project demo
node adapters/mock.js show 1024
```

数据在 `adapters/fixtures/issues.json`，直接改就行。

**改 prompt 的时候强烈建议先用 mock 跑**：不消耗真实系统的调用、数据固定所以结果可比、而且不会因为手滑往真实缺陷系统里写东西。

### GitHub 适配器

只依赖 [`gh`](https://cli.github.com/)。仓库来源优先级：`--project owner/name` > 环境变量 `GH_REPO` > `gh` 自己按当前目录探测。

```bash
export GH_REPO=owner/name
node adapters/github.js check
node adapters/github.js list --filter bug --limit 8
node adapters/github.js show 1024
```

> ⚠️ **务必设置 `GH_REPO` 或传 `--project`。** 工作流是在 worktree 目录里调用适配器的，靠 cwd 探测仓库会探到别的地方去。`check` 会检查这一点。

GitHub 没有严重程度字段，`severity` 是从 labels 推的，覆盖了 `P0/P1`、`sev1/S2`、`critical/major/minor`、中文 `致命/严重` 等常见约定，**认不出来一律给 3**——宁可给个中间值，也不要假装知道。你们的 label 约定不一样就改 `SEVERITY_RULES`。

### 禅道适配器

依赖你已配置好的 `zentao-cli`，通过环境变量指定路径：

```bash
export ZENTAO_CLI=/path/to/zentao-cli.js
node adapters/zentao.js check --project 18
node adapters/zentao.js list --project 18 --filter unresolved
```

---

## 写一个新适配器

照着 `adapters/github.js` 改最快。骨架长这样：

```js
const { execFileSync } = require('node:child_process')
const run = (args) => JSON.parse(execFileSync('your-cli', args, { encoding: 'utf8' }))

function list({ project, filter, limit }) {
  const raw = run([/* 你的列表命令 */])
  return {
    issues: raw.map(i => ({
      id: String(i.id),
      title: i.title,
      severity: mapSeverity(i.priority),   // ← 归一化：各家等级 → 统一 1-4
      url: i.url,
    })).sort((a, b) => a.severity - b.severity),
  }
}

function show(id) {
  const i = run([/* 你的详情命令 */])
  const { steps, expected, actual } = parseBody(i.description)  // ← 归一化：拆出判据
  return { id: String(i.id), title: i.title, severity: mapSeverity(i.priority),
           steps, expected, actual, comments: [...], url: i.url }
}
```

注意那两行标了 `← 归一化` 的——**它们才是适配器存在的理由**。剩下的都是样板。

写完自测：

```bash
node adapters/<你的>.js check
node adapters/<你的>.js list --project <x> | jq '.issues[0]'
node adapters/<你的>.js show <id>          | jq '{steps, expected}'
```

**重点看 `expected` 提得对不对，拿真实数据跑，别只看构造的例子。**

`github.js` 里那条吃掉 markdown 粗体的正则（`**Expected:** x`）就是拿真实 issue 跑出来才发现的——之前 `expected` 会以 `** ` 开头。**它不报错**，只是让复核 Agent 的判据里混进了标记符号。这类问题构造用例是想不到的。

> **这个字段的质量直接决定复核环节是不是在空转。**
