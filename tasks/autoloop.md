# Autoloop — Three-Agent Architecture

> Design doc for the autoloop feature. The codebase only knows this one
> architecture; an earlier "phase-machine" approach was shipped briefly and
> replaced before any external user adopted it. Comparison notes below are
> retained for rationale, not because both designs coexist.

---

## 1. Background: why three agents, not a phase machine

A phase machine (BOOTSTRAP → PROPOSE → EXECUTE → MEASURE → RATCHET → COMPRESS)
where each phase spawns a fresh Claude session is intuitive but loses on three
fronts:

1. **Token waste.** Every phase reloads plan + history + metrics from disk and
   feeds them into a fresh context. No specialisation sediment — the "Planner"
   persona is just a different prompt over the same stateless instance.
2. **No human interface.** Fire-and-forget. The user kicks off the loop and
   watches a log stream. There is no one to talk to mid-run.
3. **Roles do not own context.** Coder needs codebase familiarity that survives
   across iters. Reviewer needs an accumulating mental model of "fakery
   patterns". Stateless phases throw both away every iter.

The current design reframes autoloop as **a Planner agent that you converse
with, which supervises a Coder + Reviewer subloop**. Three persistent agents,
each owning a slice of context.

---

## 2. UX vision (the north star)

```
1. 你: `autoloop start --workspace ~/foo`
2. → 进入 chat 模式，对面是 Planner (Opus, 常驻 session)
3. 你和 Planner 深度讨论 idea：
     - 目标是啥
     - 现有代码什么状态（Planner 自己读 workspace）
     - 验收标准 (gates / metric) 怎么定
     - 风险点 / 禁区
4. Planner 把讨论沉淀成 plan.md + goal.json + 一份给 Coder 的 system prompt + 一份给 Reviewer 的 rubric
5. Planner 提议 "准备好了，开干？" — 你点头
6. Planner 起 Coder + Reviewer (各自常驻 session)，发出第一个 directive
7. Coder + Reviewer 自治跑 PROPOSE→EXECUTE→MEASURE→RATCHET 循环，写 ledger
8. Planner 监督，关键事件触发时：
     - 内部消化 (默认静默推进)
     - 或 push 你 (微信 / webchat / 邮件 fallback chain)
9. 你随时可以打断 Planner 聊天调整方向；Coder/Reviewer 不直接对你说话
10. 命中 target / 你叫停 → terminate, ledger 留底
```

**核心心智模型**: Planner 是项目经理 + 你的人形接口。Coder + Reviewer 是 Planner
的下属，跑在 Planner 调度下。你 95% 的时间只跟 Planner 对话。

---

## 3. Architecture

### 3.1 三个 Agent

| Agent | Engine | 持有 context | 输入 | 输出 |
|---|---|---|---|---|
| **Planner** | Claude (Opus 推荐) | plan.md / goal.json / 已尝试方向 / 失败模式记忆 / 与人对话历史 | 人类目标（启动一次）+ Reviewer report + Measure 结果 + 你的 chat | 本 iter 的 directive；push_user 决策；plan 修订 |
| **Coder** | Claude (Sonnet 默认，可切 engine 字段) | workspace 代码熟悉度 / 已踩坑列表 / 已尝试 patch | Planner directive | diff + eval output (写 ledger) |
| **Reviewer** | Claude (Sonnet 默认) | 历史 metric / 见过的造假模式 / gate 规则 | iter diff + eval output (沙盒 cwd 读 ledger) | ratchet 决策 + audit notes |

**Engine 策略**: 保留 `engine` 字段不删；Planner 锁 Claude（战略上下文丢不起），
Coder/Reviewer 默认 Claude，可选 codex/gemini/cursor/opencode/custom。

### 3.2 通信层

```
            ┌─────────────────────────┐
            │  你 (chat 入口)           │
            └────────────┬────────────┘
                         │
                  autoloop_chat
                         │
                         ▼
            ┌─────────────────────────┐
            │  Planner (Opus)         │
            │  - long-lived session   │
            │  - inbox: planner_in    │
            │  - tools: notify_user,  │
            │    spawn_subagents,     │
            │    write_plan,          │
            │    pause/resume,        │
            │    query_ledger         │
            └──┬──────────────────┬───┘
               │                  │
        coder_in inbox     reviewer_in inbox
               │                  │
               ▼                  ▼
        ┌──────────┐      ┌────────────┐
        │ Coder    │      │ Reviewer   │
        │ (Sonnet) │      │ (Sonnet,   │
        │          │      │  sandbox)  │
        └────┬─────┘      └─────┬──────┘
             │                  │
             └────► ledger ◄────┘
                  (state.json /
                   metric.json /
                   iter/<n>/...)
                       │
                       ▼
                 planner_in inbox
                 (events: iter_done,
                  regression, etc)
```

- **主通信走 inbox** (`inbox-manager.ts`，已有原语)
- **ledger 降级为取证 + replay**，不是通信总线
- **每个 agent 一个 named persistent session** (`persistent-session.ts`，已有原语)
- AutoloopRunner 退化成薄编排器：路由 inbox 消息、判定 iter 边界、写 ledger commit

### 3.3 消息 schema (inbox)

所有消息 envelope:
```json
{
  "msg_id": "<uuid>",
  "iter": 7,
  "from": "planner" | "coder" | "reviewer" | "runner" | "user",
  "to":   "planner" | "coder" | "reviewer" | "runner",
  "type": "<see below>",
  "ts": "<iso8601>",
  "payload": { ... }
}
```

**消息类型**:

| from → to | type | payload |
|---|---|---|
| user → planner | chat | `{ text }` |
| planner → coder | directive | `{ goal, constraints, success_criteria, max_attempts }` |
| coder → planner | directive_ack | `{ understood: bool, clarification?: string }` |
| coder → runner | iter_artifacts | `{ diff, eval_output, files_changed }` |
| runner → reviewer | review_request | `{ iter, ledger_path, prior_metrics }` |
| reviewer → runner | review_verdict | `{ decision: "advance"|"hold"|"rollback", metric, audit_notes }` |
| runner → planner | iter_done | `{ iter, verdict, metric, regression?: bool }` |
| planner → user | push_user | `{ level, summary, detail?, channel }` (via notify_user tool) |
| planner → runner | pause | `{ reason }` |
| planner → runner | resume | `{}` |
| planner → runner | terminate | `{ reason }` |

### 3.4 Phase machine: where it lives now

Phase 概念保留用于可视化 + ledger 时间线，但执行下沉到 Coder/Reviewer 的内部
脚手架：

- **Coder** 收到 directive → 内部跑 PROPOSE → EXECUTE → MEASURE → 把 artifacts
  发给 runner → runner 转给 Reviewer
- **Reviewer** 收到 review_request → 跑 RATCHET → 返回 verdict
- **Runner** 收 verdict → commit ledger → 通知 Planner → Planner 决策下一 directive
- **COMPRESS** 由 Runner 主动触发，每 N iter 给 Coder/Reviewer 各发一个 compact 信号

---

## 4. Plugin tool surface

### 4.1 用户面工具 (CLI / webchat / openclaw plugin)

| Tool | 用途 |
|---|---|
| `autoloop_start` | 启动 run，进入 Planner chat 模式 (返回 run_id + planner_session_id) |
| `autoloop_chat` | 跟 Planner 发消息 / 接续会话 |
| `autoloop_status` | 看 run 整体状态 (iter / phase / metric / 最近 push) |
| `autoloop_list` | 列所有 active runs |
| `autoloop_pause` | 暂停 (Coder/Reviewer 不开新 iter，Planner 还能聊) |
| `autoloop_resume` | 恢复 |
| `autoloop_stop` | 终止 |
| `autoloop_inject` | 直接注入 user→planner 消息（等价 chat，用于自动化） |
| `autoloop_inspect` | 看任意 agent 的 session 当前 context summary（debug 用） |
| `autoloop_reset_agent` | 重启某个 agent（Coder / Reviewer），从 ledger 恢复（不重启 Planner） |

### 4.2 Planner 内部可调工具 (通过 Claude Code 的 tool 机制暴露给 Planner agent)

| Tool | 用途 |
|---|---|
| `notify_user` | push 用户，参数 `{ level, summary, detail?, channel }`，内部走 fallback chain |
| `spawn_subagents` | "plan ready, 开干" 时调一次，起 Coder + Reviewer |
| `write_plan` | 写 plan.md (commit 到 git) |
| `write_goal` | 写 goal.json |
| `send_directive` | 发 directive 给 Coder |
| `query_ledger` | 读 ledger 任意一 iter 的 artifacts / verdicts |
| `update_push_policy` | 改 push 频率（你在 chat 里说"以后每 iter 都告诉我"时调） |
| `pause_loop` / `resume_loop` | 暂停 / 恢复 Coder/Reviewer 子 loop（Planner 跟你商量时常用） |
| `terminate` | 终止整 run |

---

## 5. Push 集成 (基于 push-api-skill)

### 5.1 `notify_user` 实现

封装 `~/.claude/skills/push-api-skill/SKILL.md` 里那个 fallback chain shell
function。Planner 不写 shell，调 tool。

伪代码:
```ts
async notify_user({ level, summary, detail, channel = "auto" }) {
  const emoji = { info: "🔔", warn: "⚠️", decision: "🚦", error: "❌" }[level];
  const msg = `${emoji} [${run_id}] ${summary}`;

  if (channel === "webchat" || channel === "both" || channel === "auto") {
    if (webchat_session_id) {
      // detail 优先；没有就 summary
      sendShellWebchat(webchat_session_id, detail ?? summary);
    }
  }

  if (channel === "wechat" || channel === "both" || channel === "auto") {
    // 微信 → WhatsApp → email fallback chain (照抄 SKILL.md push())
    pushFallbackChain(msg);
  }

  if (channel === "email") {
    sendEmail(`[autoloop ${run_id}] ${summary}`, detail ?? summary);
  }

  // 记到 ledger 的 push log，可视化用
  appendPushLog({ ts, level, summary, channel, msg_id });
}
```

### 5.2 默认 push policy

```yaml
on_start:               { level: info,     channel: wechat }   # "🔁 已启动 X，结束/卡住会通知"
on_iter_done_ok:        { silent: true }                       # 静默推进
on_target_hit:          { level: info,     channel: both }     # 命中 target
on_metric_regression_2: { level: warn,     channel: both }     # 连续 2 iter 退步
on_reviewer_reject_2:   { level: warn,     channel: both }     # Reviewer 第二次拒收
on_phase_error:         { level: error,    channel: both }     # 任何 phase 抛错
on_stall_30min:         { level: warn,     channel: wechat }   # 30 min 无 phase 推进
on_decision_needed:     { level: decision, channel: both }     # Planner 自己判定要决策
```

Planner 可在 chat 里被你调成"以后每 iter 都告诉我"或"只搞砸时叫我"——它通过
`update_push_policy` tool 改这套 yaml。

### 5.3 入站微信回话 (deferred)

3.5.0 范围：**微信 / 邮件 单向 push**。回复走 webchat 或 `autoloop_chat` CLI。

后续：openclaw gateway 加一条路由 `⚙️autoloop:<run_id>:<msg>` →
`POST /autoloop/<run_id>/inject` → Planner 收到 user chat 消息。需要改 openclaw
gateway 的 hook，独立 PR。

---

## 6. Plan finalization gate

**默认 (b)**: Planner 写完 plan.md 后调 `notify_user(level=decision, summary="plan
ready, go?")`，等用户在 chat 里说 "go" / "开干" / "ok" 才调 `spawn_subagents`。

**可切 (a)**: 用户在 plan.md frontmatter 里写 `auto_proceed: true`，Planner 写完
plan 自动调 `spawn_subagents`，不等批准。

---

## 7. Compact / 重启策略

### 7.1 自动 compact 触发

每个 agent 独立监控自己的 input token budget:

| Agent | 阈值 | 触发动作 |
|---|---|---|
| Planner | input > 80% context | 自总结 "已尝试方向 / 失败模式 / 当前 plan 状态" → 写到 ledger 的 `planner_memory.md` → reset session → primer 包含这份 memory |
| Coder | input > 70% context | 自总结 "对代码库的理解 / 已踩坑列表" → `coder_memory.md` → reset → primer 含 memory |
| Reviewer | input > 70% context | 自总结 "见过的造假模式 / 历史 metric 趋势" → `reviewer_memory.md` → reset → primer 含 memory |

### 7.2 手动 reset

`autoloop_reset_agent <run_id> <agent>` — 用户在 chat 里看到 Planner 跑歪了
("你怎么忘了我们说不能改 X"), 调这个工具强制 reset。Coder/Reviewer 同理。

**Planner reset 是危险动作**: 用户对话历史会丢，需 Planner 自己先把当前 plan
状态写回 plan.md。Reset 前必须 push 用户确认。

### 7.3 崩溃恢复

| Agent 崩 | 自动恢复? | 恢复路径 |
|---|---|---|
| Coder subprocess 死 / 401 / context 爆 | ✅ 自动 | 从 `coder_memory.md` + 当前 plan.md 起新 session |
| Reviewer 同上 | ✅ 自动 | 同上 |
| Planner 崩 | ❌ 必停 | 推 push 给用户，等手动 `autoloop_reset_agent --force` |

理由 (CLAUDE.md 恢复路径设计原则): 救援路径必须比被救对象更简单。Coder/Reviewer
的 memory 是机器写的可重建的；Planner 的 memory 包含跟人的对话语境，丢了风险高。

---

## 8. Ledger schema

```
<workspace>/tasks/<run_id>/
├── plan.md               # Planner-authored, git-committed
├── goal.json             # Planner-authored, git-committed
├── push_log.jsonl        # notify_user 调用日志 (channel + outcome)
├── planner_memory.md     # compact 产物 (Planner 自己维护)
├── coder_memory.md       # compact 产物 (Coder)
├── reviewer_memory.md    # compact 产物 (Reviewer)
├── reviewer_sandbox/     # Reviewer cwd; 每 iter 重新 stage
└── iter/<n>/
    ├── directive.json    # Planner → Coder 的本 iter 指令
    ├── diff.patch        # 本 iter 的 git diff
    ├── eval_output.json  # Coder 报告的 eval 结果
    └── verdict.json      # Reviewer 决策 + audit notes
```

每 iter 由 orchestrator 自动 git commit；Coder 不要手动 commit。

---

## 9. 可视化映射 (3-pane UI)

```
┌─────────────────────┬──────────────────┬──────────────────┐
│ Planner Chat        │ Coder Activity   │ Reviewer Audits  │
│ (你 ⇄ Planner)      │ (read-only)      │ (read-only)      │
│                     │                  │                  │
│ [user]: 我们这版的   │ iter 7:          │ iter 7 verdict:  │
│   重点是把 X 重构   │  - propose: ...  │  decision: hold  │
│ [planner]: 明白，    │  - execute: ...  │  audit: gate B   │
│   我建议先...        │  - measure: 0.83 │    failed (...)  │
│ [user]: 同意         │                  │                  │
│ [planner] (typing...) │ iter 8:        │ iter 8 verdict:  │
│                     │  - propose: ...  │  decision: ...   │
│                     │                  │                  │
└─────────────────────┴──────────────────┴──────────────────┘
┌──────────────────────────────────────────────────────────┐
│ run X: iter 8/∞ · phase EXECUTE · metric 0.83 (↑0.05)    │
│ push log: 🔔 started · ⚠️ regression at iter 5            │
└──────────────────────────────────────────────────────────┘
```

UI 走"集成进现有 webchat"路线（上一轮商定）；orchestrator 这边只负责 SSE +
HTTP API。三 pane 数据源:
- 左: `GET /autoloop/<id>/planner/messages` + WebSocket 流
- 中: `GET /autoloop/<id>/coder/activity` (SSE)
- 右: `GET /autoloop/<id>/reviewer/verdicts` (SSE)
- 顶 bar: `GET /autoloop/<id>/state`
- 底 push log: `GET /autoloop/<id>/push_log`

---

---

## 11. 已知风险 / 开放问题

1. **Planner 的"plan ready" 判定准吗？** Planner 自己决定 plan 写完了——可能写半截就提议开干。Mitigation: `spawn_subagents` 工具内部加 sanity check (plan.md 至少含 N 个 section, goal.json 必填字段齐了, gates ≥ 1 个)。

2. **Coder/Reviewer 跨 iter persistent session 会不会自己漂移？** 监控 token budget + compact 阈值是机械防御；如果他们 prompt-level 漂了，Reviewer 拒收应该能兜住。如果 Reviewer 也漂了 → Planner 看到反复 reject 会 push 用户。

3. **微信 push 节流**: SKILL.md 警告"同一事件别短时间反复发"。Planner 没有时间感，可能误推。Mitigation: `notify_user` 内部记最近 N 条 push，类似事件 dedup 5 min。

4. **三个 persistent session 总成本**: 估算每天闲置 base cost ~$0.5-1/agent/day（context refresh），三个加起来约 $2-3/day/run。用户说不省钱，先不优化。

5. **Reviewer 沙盒 cwd**: Reviewer 是常驻 session，cwd 一旦定下来不能换。方案: Reviewer cwd 设在 `ledger/reviewer_sandbox/`，每次 review 前 runner 把当 iter 的 diff + eval_output 拷贝到这里 → Reviewer 在它自己的 cwd 看到的永远是"最新一 iter 的快照"。

6. **微信入站 deferred 的体验冲击**: 用户接到微信 push 后没法直接微信回话，得开 webchat。可能反人类。Mitigation: push 消息里附 webchat 直接 deeplink (`https://claw.enderfga.cn/?autoloop=<id>`)，点开就接续 chat。

---

## 12. Out of scope

- ❌ 多 Planner 并行（一个 run 一个 Planner，不搞议会）
- ❌ Coder/Reviewer 直接对用户说话（必须经 Planner 转）
- ❌ 自动 PR / commit push 远端（只做本地 ledger commit）
- ❌ 跨 run 知识共享（每个 run 的 memory 隔离）
- ❌ 微信入站 → Planner（deferred）

---

## 13. 决策记录

| 日期 | 决策 | 来源 |
|---|---|---|
| 2026-05-10 | 用三常驻 agent，不用 oneshot phase 机 | 安总 |
| 2026-05-10 | Planner = Opus only; Coder/Reviewer 默认 Claude 但保留 engine 字段 | 安总 |
| 2026-05-10 | 默认 plan ready 等用户批准 (option b)；可在 plan.md 切 auto_proceed | 安总确认 |
| 2026-05-10 | 微信单向 push 是 3.5.0 范围；入站 deferred | 安总确认 |
| 2026-05-10 | 双推 (微信 + webchat) 是默认；email 是 fallback 链尾 | 抄 push-api-skill SOP |
| 2026-05-10 | UI 集成进 webchat (路线 A)，不内嵌 plugin | 上一轮决定 |
| 2026-05-10 | 不在代码 / 配置 / 工具名里留 v1/v2 标签；项目里只有当前一个 autoloop | 安总 |

---

*Last updated: 2026-05-10*
