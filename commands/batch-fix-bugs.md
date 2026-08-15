并行修复一批未解决缺陷：拉列表 → 人工确认 → 每个 bug 一个隔离 worktree 并行修复+独立复核 → 产出三分类报告。**默认不 commit、不推送、不回写缺陷系统**。

缺陷系统通过**适配器**接入，本命令不关心你用的是禅道 / Jira / GitHub Issues。契约见 `ADAPTERS.md`。

## 参数

`$ARGUMENTS` —— 形如 `<项目名或ID> [过滤类型] [max=N]`

- **项目名/ID**（必填）：传给适配器 `list --project` 的值
- **过滤类型**（可选）：原样透传给适配器 `list --filter`，**本命令不解释它的含义**（禅道是 `unresolved` / `assigntome`，GitHub 可能是 label）
- **max=N**（可选，默认 `8`）：一次最多修几个。severity 高的优先，被截断的数量要 `log` 出来。

  > `8` 不是机器的极限，是**人一次能认真审几个 diff 的极限**。不建议调大——详见 README「已知局限」。

## 需要配置的路径

- **适配器调用前缀** `tracker`：如 `node <仓库>/adapters/zentao.js`
  - 不接真实系统时用 `node <仓库>/adapters/mock.js` 先跑通流程
- **workflow 脚本**：`~/.claude/workflows/batch-fix-bugs.workflow.js`

开跑前先自检适配器，避免 8 个 Agent 一起撞到配置问题：

```bash
<tracker> check
```

## 执行步骤（严格按序，人工卡点不能跳过）

### 1. 解析参数 + 定位仓库（必须人工确认，禁止猜）

- 从 `$ARGUMENTS` 取出项目、过滤类型、max。
- 把项目映射到本地仓库目录。**不要凭名字自动认定**——名字相似的仓库（如 `project-a` 与 `project-a-weixin`）光看项目名区分不出来。用 AskUserQuestion 或直接问：「项目 X → 仓库 `<绝对路径>`，对吗？」得到确认后再继续。

  > 这是全流程最危险的一步：错了会被放大 N 倍——**N 个 Agent 在错误的仓库里认真改代码，而且不会报错，会给你一份格式完美的报告。**

- 记录 `repoPath`（绝对路径）与基础分支：`git -C <repoPath> branch --show-current`。所有 worktree 都基于这个基础分支创建。

### 2. 拉缺陷列表

```bash
<tracker> list --project <项目> --filter <过滤类型>
```

解析 JSON（`{ issues: [{ id, title, severity, url }] }`），按 `severity` 升序（1 最严重）排序后取前 `N` 条；`log` 出「共 M 条，本轮取 N 条，截断 M-N 条」。

**截断数量必须打出来** —— 静默截断会让人以为「全都处理了」。

### 3. 展示 + 人工确认（卡点）

列出将要修的 N 个 bug（`#id 标题 [严重度]`），请用户确认或增删。**用户未确认不得进入下一步。**

### 4. 为每个 bug 建隔离 worktree（主会话串行做，避免并发锁竞争）

`git worktree add` 要写 `.git`，并发跑会撞锁。这步很快，串行不值得优化。

对每个确认的 bug：

- 分支名 `batchfix/bug-<id>`，worktree 目录放在**持久目录**：

  > ⚠️ **不要用会话临时目录** —— 会话结束或清理后未合并的改动会丢失，而**这些改动就是交付物**。

  建议放在各仓库之外的位置，如 `<仓库父目录>/.batchfix-worktrees/<repoName>/bug-<id>`：放在任何一个仓库内部都会污染那个仓库的 `git status`。

- 建 worktree（基于步骤 1 的基础分支）：
  ```bash
  git -C <repoPath> worktree add -b batchfix/bug-<id> <worktreeDir> <baseBranch>
  ```
  若分支或目录已存在，先清理：`git -C <repoPath> worktree remove --force <worktreeDir>` 与 `git -C <repoPath> branch -D batchfix/bug-<id>`，或换个后缀。

- 软链依赖，避免装包、避免并行写冲突：
  ```bash
  ln -s <repoPath>/node_modules <worktreeDir>/node_modules
  ```

  > fresh worktree 没有 `node_modules`（它在 `.gitignore` 里），不软链的话 type-check/lint 会因缺依赖**假失败**——而 Agent 可能把假失败当成"我改坏了"，然后去改根本没坏的东西。

  若是 monorepo / pnpm workspace，root 之外的子包也各有 `node_modules`，需对每个子包目录同样软链；实在理不清就在传给 agent 的说明里改为「只跑不依赖装包的检查」。

- 收集 `{ id, title, severity, worktree: <绝对路径>, branch }`。

### 5. 调用工作流

```
Workflow({
  scriptPath: '~/.claude/workflows/batch-fix-bugs.workflow.js',   // 用展开后的绝对路径
  args: {
    project:  '<项目名>',
    repoPath: '<绝对路径>',
    tracker:  '<适配器调用前缀，如 node /abs/adapters/zentao.js>',
    bugs:     [ ...上面收集的 ],
  }
})
```

工作流在后台跑，收到 `task-notification` 后取返回值（`{ project, repoPath, total, results }`，每条 `results` 含 `{ bug, fix, verify }`）。

### 6. 产出三分类报告（这是交付物）

把 `results` 分三类，写成 markdown 报告（存到**持久目录**，与 worktree 同处，别放临时目录；并在对话里给摘要）：

- **✅ 可审核合并**（`verify.verdict === 'pass'`）：每条列 根因、改动文件、worktree 分支、`git -C <worktree> diff` 查看方式、自测结论（`checksRun`）。
- **⚠️ 需人工确认**（`verify.verdict === 'needs-human'`）：列 `verify.reason` / `fix.reason`。
- **❌ 没搞定**（`verify.verdict === 'reject'` 或修复失败）：列原因，建议人工处理。

### 7. 交接（不要自动做，明确告诉用户后续动作）

- 逐条审 diff → 把认可的改动合回基础分支（`git cherry-pick` / `git -C <worktree> diff | git -C <repoPath> apply`）→ **由用户手动 commit**，得到真实 Commit ID。
- 之后（可选）把修复说明 + **真实 Commit ID** 回写到缺陷系统。
- **红线**：没有真实 commit hash 时，禁止自动回写缺陷系统。

  > 当一个字段必须填、而正确答案不可得时，模型会填一个格式正确的值——一串完全合法的 40 位十六进制。这条假记录污染的是**整个团队对「这个 bug 修没修」的共识**，而且很难发现、很难回滚。

- 清理：用户确认后再逐个 `git -C <repoPath> worktree remove <worktreeDir>` 并 `git -C <repoPath> branch -D batchfix/bug-<id>`。

## 安全红线（贯穿全程）

- 只在隔离 worktree 内改代码；**绝不** commit/push 基础分支、**绝不**自动回写缺陷系统。
- 修不动、拿不准 → 标 needs-human，不硬编。
- 项目→仓库映射、待修 bug 清单，两处都必须人工确认后才继续。
