# Agent teams: structure, per-agent vs team todos, message propagation (state of the art, Oct 2026)
_scope: sources 2025-06 → 2026-10, generic lens, deep dive, Exa only (user choice; Reddit/YouTube skipped) • generated 2026-10-17_
_source tags: every claim is [E] (Exa web) plus a source-type marker: **docs** (official docs) · **src** (source code) · **blog** (vendor engineering blog) · **paper** · **3p** (third-party teardown or practitioner). URLs are in the Sources section and inline where useful._

**How to read this.** Trust official docs and source code most. Next come vendor blogs that report measured numbers, then papers. Third-party teardowns (Claude Code inbox and task JSON internals, for example) are reverse-engineered and may be out of date; they are marked **3p**. Every number here was reported by its source. None was measured by us. The recommended design in §8 and the code sketch in §9 are my synthesis and **have not been tested**.

---

## TL;DR
1. **The leading systems have all ended up with the same shape:**
   - One lead owns the plan and the team board.
   - Workers start with fresh, fenced context and return a condensed final result plus artifact paths.
   - Durable state lives in files or a store, not in chat.

   Systems with this shape: Claude Code agent teams, Anthropic's research system, Magentic-One, Cursor's planner/worker/judge setup, OpenAI's Responses multi-agent, and deepagents. [E: docs/blog, §1]
2. **Use two tiers of todo:**
   - Each agent keeps a private todo as scratch space.
   - There is **one team board**: a single owner writes the plan, each task row has one writer, claims are atomic, and dependencies are explicit.

   Claude Code puts the board in `~/.claude/tasks/{team}/` with file-locked claims and dependency auto-unblock. Magentic uses a Task Ledger plus a Progress Ledger. A2A tracks a `TaskState` on every task. **deepagents has no team board.** It deliberately keeps `todos` out of subagent input and output, so you have to build the board yourself (§5, §8). [E: docs/src]
3. **Message delivery:**
   - Messages are point-to-point, go into a per-agent mailbox, and the harness injects them at the recipient's next turn boundary. The recipient never has to poll.
   - When a worker stops, the lead gets an automatic idle or completion notification that carries the worker's final answer.
   - Avoid broadcast chatter and peer-to-peer chatter between workers. Current Claude docs say "send one message per recipient". Cursor's workers "don't coordinate with other workers". Cognition recommends "map-reduce-and-manage".
   - deepagents has no peer channel. Its async subagents are pull-based (`check_async_task`), and steering a running worker means interrupting and restarting it. [E: docs/blog]
4. **Use teams only for parallel, breadth-first work.** Google's study of 180 configurations found:
   - +80.8% on a parallelizable task
   - −39% to −70% on a sequential task
   - −3.5% on average
   - 1.6–6.2× the token budget

   Anthropic's research system scored 90.2% higher than a single agent but uses about 15× the tokens of chat. Claude Code teams use about 7× the tokens in plan mode. Keep writes single-threaded and add agents for intelligence (review, verification), not for more actions (Cognition, Apr 2026). [E: paper/blog/docs]
5. **Better messaging and role prompts alone don't fix team failures.**
   - MAST traced failures to three sources: about 42–44% specification, 32–37% inter-agent misalignment, 21–24% verification.
   - Anthropic's 2026 swarm studies found role and "CEO" prompts "did not make much difference".
   - What does help: a central validator (cut error amplification from 17.2× to 4.4×), a strong oracle or verifier, partitioning file ownership, stall detection with replanning, and an explicit delegation contract. [E: paper/blog]

---

## Key findings (in depth)

### 1. The shared architecture: lead, fenced workers, files as shared memory

| System | Who owns the plan/board | What a worker sees | What comes back | Shared medium |
|---|---|---|---|---|
| **Claude Code agent teams** [docs] | Fixed lead. Shared task list that teammates can self-claim | Fresh context: CLAUDE.md, MCP servers, skills, spawn prompt. **Never the lead's history** | Idle notification carrying the final answer, plus `SendMessage` | `~/.claude/tasks/{team}/`, per-agent inbox JSON, **same working tree (no worktrees)** |
| **Claude Code / Agent SDK subagents** [docs] | Parent | Fresh context | **Final message only**, typically a 1,000–2,000-token summary [blog] | Filesystem |
| **Anthropic research system** [blog, 2025-06-13] | Lead, which saves its plan to Memory because context over 200K is truncated | Fresh context plus a delegation contract | "Lightweight references" to artifacts stored externally | Filesystem / external store |
| **Claude Managed Agents** [docs] | Primary thread. Delegation is **one level deep**, at most **25 child threads** | Its own persistent thread | Turn-end report delivered as `agent.thread_message_received` | **One shared sandbox, filesystem and vault** |
| **deepagents** [src/docs] | Supervisor, through its own `write_todos` | `isolated`: task text plus state minus excluded keys. `fork`: parent history too | Final AI message or structured JSON as a `ToolMessage`, plus changed non-excluded state keys | Backends: `StateBackend` (merged when the child returns) or Store/sandbox (live) |
| **Magentic-One / Microsoft Agent Framework (MAF)** [src/docs] | Orchestrator: Task Ledger plus Progress Ledger rebuilt every round | Shared chat history. The manager picks who speaks next | Reply into the group chat | Chat history |
| **OpenAI Responses multi-agent** [docs] | Root agent. `list_agents` returns the tree | `fork_turns` controls how much parent context the child inherits | `FINAL_ANSWER` is pushed to the parent | Mailbox. The Agents API variant has a shared filesystem |
| **Cursor "scaling agents"** [blog, 2026-01-14] | Planners (which can spawn sub-planners). A judge decides whether to continue | Workers "don't coordinate with other workers" | git commits | git |
| **Anthropic C compiler** [blog, 2026-02-05] | **None.** "I don't use an orchestration agent." | Its own container and clone (`/upstream` → `/workspace`) | git push | Lock files in `current_tasks/` in git |

The common thread: **state that must survive goes into a file or store with a clear owner, and only condensed summaries plus pointers travel in messages.** Anthropic's research system: "Subagents call tools to store their work in external systems, then pass lightweight references back to the coordinator." [blog]

### 2. Separating responsibilities: how roles are fenced
- **The lead is the only manager, and nesting is capped.**
  - Claude teams: "Lead is fixed", "No nested teams: teammates cannot spawn their own teammates", "One team per session". [docs]
  - Managed Agents: one level deep, at most 25 child threads, `predefined_agents` up to 20. [docs]
  - Codex: `agents.max_depth` default 1, `agents.max_threads` default 6. [docs]
  - ADK: an agent can have only one parent; adding a second raises `ValueError`. [docs]
  - Cursor is the exception: planners can spawn sub-planners. [blog]
- **Fence by tools, not by persona.**
  - deepagents `SubAgent.tools`: "When specified, overrides the inherited tools entirely". `FilesystemMiddleware(tools=...)` sets a filesystem-tool allowlist. `middleware` and `system_prompt` are not inherited in isolated mode. [src/docs]
  - Codex fences with `developer_instructions` and `sandbox_mode`, e.g. read-only. [docs]
  - Claude Code roles are subagent definitions: a `tools` list plus a prompt. Teammates inherit the lead's permission mode, and their permission prompts appear in the lead's session. [docs]
- **Fence by files.**
  - Claude: "Agent teams don't isolate teammates in worktrees, so partition the work so each teammate owns a different set of files." "Two teammates editing the same file leads to overwrites." For large changes, `/batch` splits the work across 5–30 subagents isolated in worktrees. [docs]
  - The C compiler run gave each agent its own container and clone, synchronized through git. [blog]
  - Cursor's flat shared coordination file with locks failed: "Twenty agents would slow down to the effective throughput of two or three"; "agents could fail while holding locks… or update the coordination file without acquiring the lock at all". [blog]
- **Separate writers from readers.**
  - Cognition (2026-04-22): "multi-agent systems work best today when writes stay single-threaded and the additional agents contribute intelligence rather than actions." [blog]
  - LangChain: "Reads parallelize more easily than writes." [docs]
  - LangChain (2026-09-08): use **`fork` for workers** that continue the supervisor's work and **`isolated` for verifiers**, so the supervisor's view doesn't anchor them. [blog]
  - Cognition: Devin Review works best "when the coding and review agents do not share any context beforehand", and catches "an average of 2 bugs per PR, of which roughly 58% are severe". [blog]
- **Personas matter much less than structure.**
  - Anthropic 2026: role and "CEO" prompts "did not make much difference". [blog]
  - MAST: "improving agent role *specifications* alone yields a +9.4% success rate increase for ChatDev". [paper]
  - My reading of the two: specifying task boundaries and inputs/outputs helps; persona framing doesn't. (See Contested.)

### 3. Progress visibility: per-agent todo vs team todo

**How each system represents it**

| System | Private per-agent todo | Team-level board / ledger | Claim / ownership | "Done" gate |
|---|---|---|---|---|
| **Claude Code teams** | Each teammate has its own context | Shared list in `~/.claude/tasks/{team-name}/`. States **pending → in progress → completed**. Dependencies: "a pending task with unresolved dependencies cannot be claimed until those dependencies are completed" [docs] | Lead assigns, **or** a teammate self-claims ("after finishing a task, a teammate picks up the next unassigned, unblocked task on its own"). "Task claiming uses file locking" [docs] | Hooks `TaskCreated` / `TaskCompleted`: "Exit with code 2 to prevent completion" [docs] |
| **Claude Code single session** | `TaskCreate/TaskGet/TaskList/TaskUpdate` (`TodoWrite` is legacy and off by default) | Same list, shareable across sessions with `CLAUDE_CODE_TASK_LIST_ID=my-project claude` [docs] | — | "Tasks persist across context compactions" [docs] |
| **deepagents** | `write_todos` → `todos: list[Todo{content, status: pending\|in_progress\|completed}]`. Replaces the whole list, at most once per model turn [src] | **None built in.** `todos` is in `_EXCLUDED_STATE_KEYS`, so it never enters or leaves a subagent (a test checks parallel isolation). For async jobs only, the lead has an `async_tasks` channel (task ID, agent, thread, run, status, timestamp) [src/docs] | — | — |
| **Magentic-One / MAF** | — (participants execute) | **Task Ledger** (facts survey plus plan) and **Progress Ledger** (5 questions answered as JSON every round), with a stall counter [src] | Manager assigns `next_speaker` | `is_request_satisfied` |
| **OpenAI Responses / Codex** | — | `list_agents`: the agent tree, statuses, each agent's `last_task_message`. Codex CSV fan-out: exported `job_id, item_id, status, last_error, result_json` [docs] | Root spawns | "Each worker must call `report_agent_job_result` exactly once" [docs] |
| **A2A** | — | A `TaskState` on every task (`SUBMITTED, WORKING, COMPLETED, FAILED, CANCELED, INPUT_REQUIRED, REJECTED, AUTH_REQUIRED`). `contextId` groups related tasks. The client builds the team view [docs] | Per task | Terminal states |
| **Anthropic long-running harness** | `claude-progress.txt` | Feature-list JSON: "over 200 features… initially marked as 'failing'". Agents may change it "only by changing the status of a passes field" [blog] | — | Test passes before the flag flips |
| **C compiler** | — | `current_tasks/` lock files in git [blog] | "git's synchronization forces the second agent to pick a different one" | GCC used as a known-good oracle |
| **Practitioners** | — | `status.yml`, one writer per row (Ferryx). SQLite board with `todo/doing/done/blocked` (amux) [3p] | Compare-and-set (CAS) claim: `UPDATE board SET session=?, status='doing' WHERE id=? AND status='todo' AND session IS NULL`. A 900 s lease where "Re-claiming refreshes the lease. That is the heartbeat" [3p] | — |

**Design rules these systems share**
1. **Keep the plan and per-task status separate, with one writer for each field.** The lead writes the plan and task definitions; the claimer writes its own task's status and result. (Claude self-claim, Ferryx "one writer per row", Magentic's manager-owned ledger.)
2. **Make claims atomic.** Options: file lock (Claude), CAS `UPDATE … WHERE status='todo'` (amux), git push conflict (C compiler). Cursor showed that a shared file with advisory locks fails at scale.
3. **Make dependencies explicit and unblock automatically.** Claude docs: dependencies unblock when the dependency completes. Third-party teardowns say `blockedBy` is resolved on every `TaskList` call. Practitioners use `depends_on`, where `done` or `dropped` unblocks.
4. **Gate "done" on something checkable.** Claude's `TaskCompleted` hook can block completion with exit code 2. In Anthropic's harness a feature's `passes` flag flips only after its test passes. Codex requires exactly one `report_agent_job_result` call per worker.
5. **Keep private todos private.** deepagents keeps `todos` out deliberately: they "do not have a defined reducer and no clear meaning for returning them from a subagent to the main agent". The team board holds task-level rows; sub-steps stay in each agent's scratch todo.
6. **Store state that agents must not casually rewrite as JSON.** Anthropic: JSON is "less likely to [be] inappropriately change[d]" than Markdown.
7. **Have the lead check progress on a schedule.** Magentic's Progress Ledger asks "satisfied? in a loop? making progress? who's next? what instruction?" every round. If `stall_count > max_stall_count` (default 3), it resets and replans.
8. **Use leases or heartbeats for crash recovery.** Re-claiming refreshes the lease; a reaper returns a dead agent's tasks to the queue. [3p]
9. **Expect status to lag.** Claude docs list "Task status can lag" as a limitation.
10. **Model-dependent note:** Claude Code's Task tools are on by default only for Opus 4.7, Sonnet 4.6, Haiku 4.5 and earlier. "On newer models, Claude keeps track of multi-step work without a written checklist." The newest models need the checklist less for single-agent work. The **team** list is a different matter, because it is a coordination surface, not a reasoning aid. [docs]

### 4. Message propagation: who sees what, and when

| System | Addressing | Transport | When the recipient sees it | Push / pull |
|---|---|---|---|---|
| **Claude Code teams** | One named teammate. Current docs: "To reach everyone, send one message per recipient" | Appended to `~/.claude/teams/{team}/inboxes/{agent}.json`. Counted as sent "only when the write to the recipient's mailbox file succeeds" | "delivered automatically… The lead doesn't need to poll". 3p: injected as `<teammate_message teammate_id color summary>` into the next user block, then marked read. Messaging a stopped teammate revives it with its saved conversation | **Push** |
| **Claude cross-session** | Session name | — | "reads the message between tool calls during an active turn… When the receiving session is idle, Claude Code starts a new turn". Queue holds at most 50. `notify_when_idle` | Push |
| **Claude background subagent** | Parent | — | "completion notification in a later turn". Resumable by `agentId` | Push |
| **Managed Agents** | `send_to_agent`, `list_agents` | Thread events | Turn-end report arrives as `agent.thread_message_received {from_session_thread_id, from_agent_name, content}`. "An interrupted child doesn't send the primary thread's agent the report" | Push |
| **OpenAI Responses multi-agent** | Agent paths `/root/...` | Mailbox | `send_message` queues a message "without starting a new turn". `wait_agent` pulls the next update. A `FINAL_ANSWER` is "immediately delivered back to your parent" | Both |
| **OpenAI Agents SDK handoff** | `transfer_to_<agent>` | Conversation | The receiving agent sees the **full history** by default, trimmed with `input_filter` / `HandoffInputData` | — |
| **deepagents sync `task`** | Parent only | `ToolMessage` | When the tool call returns, at the parent's next model call | Return value |
| **deepagents async** | Supervisor → task ID | Agent Protocol runs | `check_async_task` / `list_async_tasks` (pull: "does not poll"). `update_async_task` **interrupts and restarts** the child with its full history plus the new instructions | **Pull** |
| **LangGraph handoff** | `Command(goto, graph=Command.PARENT)` | Graph state | Next step. Passes only `[last_ai_message, transfer_tool_message]` | — |
| **LangGraph swarm** | Everyone | One shared `messages` list | Immediately (shared) | Shared |
| **A2A** | Agent endpoint | JSON-RPC/HTTP. Message (conversational) vs. Artifact (output) | Poll `GetTask`, SSE stream ("MUST close when the task reaches a terminal state"), or webhook push (`TaskPushNotificationConfig`) | Both |
| **Magentic** | Manager → selected speaker | Group chat | Each round, through `instruction_or_question` | Push, hub-and-spoke |
| **Blackboard (Google/UMass 2510.01285)** | Request broadcast on a public board | Public board, plus a **private response board** "to prevent cross-influence of sub-agents" | Helpers volunteer | Pull |
| **Cursor** | None between workers | git | On pull | Eventually consistent |

**Messaging rules these systems share**
1. **Push into the recipient's next turn rather than polling.** Claude and OpenAI both deliver into the next turn, and Claude revives idle agents. Polling wastes turns. Keep a pull API for **status** (`TaskList`, `list_agents`), but not for messages.
2. **Report completion automatically, with the final answer attached.** In Claude Code, "when a teammate finishes and stops, it automatically notifies the lead and includes its final answer". A failure notifies the lead with the error text. The lead never has to ask "are you done?".
3. **Keep plain text private; communication is an explicit act.** A 3p-quoted Claude teammate prompt says: "Your plain text output is NOT visible to the team lead or other teammates. To communicate with anyone on your team, you MUST use this tool."
4. **Keep payloads small: a summary line, a body, and pointers.** Claude `SendMessage.summary` is "typically 5-10 words", truncated past 200 characters. Subagents return 1–2K-token summaries. Pass artifact paths, not content.
5. **Separate typed protocol messages from free text.** OpenAI uses `NEW_TASK | MESSAGE | FINAL_ANSWER`. Claude (3p) uses `idle_notification`, `shutdown_request/approved/rejected`, `task_assignment`, `plan_approval_request`, `permission_request`. A2A separates Message from Artifact.
6. **Avoid the "game of telephone".** When the lead relays everything, details get lost. LangChain's June 2025 benchmark found the supervisor's translation step was what cost it against swarm. Anthropic's fix is for subagents to write artifacts directly to the filesystem.
7. **Moving context costs about as much as acting on it.** Anthropic 2026: "transmitting context is about as costly as acting on it." Cognition: for writers, "share a fork of the full context"; "Agents assume they share state with their children when they don't."
8. **Prefer point-to-point to broadcast.** Claude docs moved to one message per recipient (Feb–Apr 2026 teardowns describe an earlier broadcast). The blackboard paper uses a private response board specifically to stop agents from influencing each other.

### 5. deepagents specifically: what you get and what you build

**What you get** (as of v0.7.28 on PyPI, about Oct 2026; v0.6→v0.7 changelogs not reviewed):
- `write_todos` / `TodoListMiddleware`. **Private** to each agent; a test shows parallel subagents each keep their own list and `todos` never reaches the parent. [src]
- `task` tool / `SubAgentMiddleware`:
  - Parallel when several `task` calls are made in one turn.
  - `mode: "isolated" | "fork"`. Fork is experimental: the child inherits the parent's history and prompt middleware but can't define `skills`.
  - `response_format` returns structured JSON. Dynamic subagents can be dispatched from interpreter code.
  - Return path: `Command(update={**changed_non_excluded_keys, "messages":[ToolMessage(final_text_or_json)]})`. [src/docs]
- `_EXCLUDED_STATE_KEYS = {messages, todos, structured_response, skills_metadata, pinned_skills, …}`. **Any other changed state key flows back to the parent.** So a custom state key with a reducer is a sanctioned channel. The October 2025 docs said subagent middleware "can be particularly useful when you want to give the subagent an additional state key to share with the main agent." [src/docs]
- Async subagents (v0.5.0, 2026-04-07). Require LangSmith Deployment.
  - `AsyncSubAgent(name, description, graph_id, url?, headers?, mode?)`.
  - Tools: `start_async_task`, `check_async_task`, `update_async_task`, `cancel_async_task`, `list_async_tasks`.
  - Terminal statuses: `success | error | cancelled`. [docs]
- Backends:
  - `StateBackend` is shared between supervisor and subagents, but siblings run on snapshots. Writes merge through a dict-merge reducer when the child returns, so **siblings can't see each other's writes mid-run** (my reading of the code, not documented).
  - `StoreBackend` / sandbox / filesystem are **live-shared**, but "concurrent writes to the same file can cause last-write-wins conflicts".
  - `CompositeBackend(default=..., routes={"/memories/": StoreBackend(namespace=...)})` routes by path. [docs/src]
- Agent Server A2A endpoint at `/a2a/{assistant_id}`, where `contextId` becomes `thread_id`. `SubscribeToTask` and push-notification config **return -32601 (not implemented)**. [docs]
- `interrupt_on` for human-in-the-loop. Interrupts inside subagents propagate to the outermost graph.

**What's missing (you build it):** a team board, peer-to-peer messaging, broadcast, atomic claims, and **push** completion notifications for async subagents. That last one is uncertain: an Oct 2026 issue titled "Delayed async task notifications can replace a newer running task and stop" suggests a notification path exists that I didn't verify.

**LangChain's current guidance:**
- Start with one agent. "For built-in multi-agent support, use Deep Agents."
- `langgraph-supervisor` is "no longer actively maintained"; the recommendation is "the supervisor pattern directly via tools". `langgraph-swarm` has no deprecation notice.
- Remind subagents that "the supervisor only sees the final output".
- Handoffs pass only the AI message and its tool message. [docs]
- Numbers from 2026-01-14: subagents take about 5 calls and 9K tokens versus 3 calls and 15K tokens for skills; "Subagents processes 67% fewer tokens overall compared to Skills". [blog]

### 6. Anthropic/Claude in detail
- **Agent teams** shipped in Claude Code 2.1.32 (3p) behind `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.
  - `teammateMode`: `in-process` (default), `auto`, `tmux` or `iterm2`.
  - Team name: `session-` followed by the first 8 characters of the session ID.
  - `config.json` has a `members` array, and the lead's entry is `team-lead`. The config directory is removed at session end; the task list stays on disk (`cleanupPeriodDays`).
  - Hooks: `TeammateIdle` (exit code 2 keeps the teammate working), `TaskCreated`, `TaskCompleted`.
  - Plan approval: auto-approved in the lead's session "without the lead reviewing it".
  - Shutdown: the lead sends a request, and the teammate approves or rejects it with an explanation.
  - Limitations: no session resumption for in-process teammates, one team per session, no nesting, fixed lead, task status can lag, no background subagents from in-process teammates. [docs]
- **Sizing:**
  - "Start with 3-5 teammates… If you have 15 independent tasks, 3 teammates is a good starting point… Three focused teammates often outperform five scattered ones."
  - "5-6 tasks per teammate".
  - Cost: about 7× the tokens in plan mode. "Use Sonnet for teammates." "Shut down teammates when their work is done." [docs]
- **Research system** (2025-06-13):
  - Scored 90.2% higher than single-agent Opus 4.
  - "token usage by itself explains 80% of the variance"; three factors explain 95%.
  - Agents use about 4× the tokens of chat, and multi-agent systems about 15×.
  - Delegation contract: "Each subagent needs an objective, an output format, guidance on the tools and sources to use, and clear task boundaries."
  - Caveat: "most coding tasks involve fewer truly parallelizable tasks than research." [blog]
- **C compiler** (2026-02-05):
  - 16 agents, about 2,000 sessions, about $20,000, a 100K-line compiler, 2B input and 140M output tokens.
  - No orchestrator; lock files in `current_tasks/` plus git.
  - Failure mode: "Every agent would hit the same bug, fix that bug, and then overwrite each other's changes." The fix was a GCC oracle that let agents split the files between them. [blog]
- **Multi-agent research** (2026-08-13):
  - Setup: 45 agents, each with its own VM, a shared forum, and an arbiter.
  - Vulnerability hunting: a coordinating swarm found **266 vulnerabilities using 27M tokens**, while independent parallel agents found **21 using 6.5M**, with only 12 in common.
  - Coordination quality depends on the model. "Sonnet 4.6 and Opus 4.6 coordinated very poorly… Opus 4.8 and Mythos Preview 'solved' this problem… by hardly working together… Sonnet 5… relatively high code sharing while also maintaining a high PR throughput."
  - The study observed a "multiagent turf war". [blog]
- **Long-running harness** (2025-11-26): an initializer agent writes `init.sh`, `claude-progress.txt`, an initial git commit, and a JSON feature list marked failing; each later session works one feature. [blog]
- **Managed Agents:**
  - Exposes `subagents` / `workflows` / `advisor` (`anthropic.advisor`).
  - All agents share one sandbox. Child threads are persistent.
  - Events: `session.thread_created`, `session.thread_status_idle`, `agent.thread_message_received`. [docs]

### 7. Evidence: when teams help and when they hurt
- **Helps:** decomposable, read-heavy, breadth-first work, especially when a single agent scores below about 45%. Google's study puts the capability ceiling at about 45%, with β=−0.404.
  - Finance-Agent: centralized multi-agent +80.8% (0.631 vs 0.349).
  - Anthropic research: +90.2%.
  - Anthropic vulnerability hunting: 266 vs 21 findings.
- **Hurts:** sequential tasks with state dependencies, tool-heavy coordination, edits to the same file, and "most coding tasks".
  - PlanCraft: centralized −50.3%, independent −70.1%.
  - Tool-coordination penalty: β=−0.267.
- **Cost:** 1.6–6.2× tokens at matched performance (Google). Anthropic: 4× (agents) and 15× (multi-agent) the tokens of chat. Claude Code teams in plan mode: about 7×.
- **Topology matters.** Error amplification, single agent = 1.0: centralized 4.4, hybrid 5.1, decentralized 7.8, **independent 17.2**. Google's predictor picks the best architecture for 87% of held-out configurations.
- **Failure modes (MAST v3, 1,642 traces):**

| Failure mode | Share |
|---|---|
| Step repetition | 15.7% |
| Reasoning–action mismatch | 13.2% |
| Not recognizing completion | 12.4% |
| Disobeying task spec | 11.8% |
| Incorrect verification | 9.1% |
| No or incomplete verification | 8.2% |
| Task derailment | 7.4% |
| Failing to ask for clarification | 6.8% |
| Premature termination | 6.2% |

  - "Solutions focused on context or communication protocols are often insufficient" for misalignment failures.

---

## 8. Recommended design for a deepagents team (synthesis, not tested)

```
                ┌──────────── Lead (create_deep_agent) ────────────┐
                │ private write_todos  ·  Progress-Ledger each turn │
                │ only writer of task definitions on the TEAM BOARD │
                └──────┬───────────────┬───────────────┬───────────┘
       task()/async    │               │               │   (isolated) reviewer
              ┌────────▼───┐   ┌───────▼────┐   ┌──────▼─────┐   ┌──────────┐
              │ worker A   │   │ worker B   │   │ worker C   │   │ verifier │
              │ own todos  │   │ own todos  │   │ own todos  │   │ fresh ctx│
              │ owns files │   │ owns files │   │ owns files │   │ read-only│
              └─────┬──────┘   └─────┬──────┘   └─────┬──────┘   └────┬─────┘
                    └──── TEAM BOARD + INBOXES in LangGraph Store ────┘
                          ("team", run_id, "tasks") / ("team", run_id, "inbox", name)
```

1. **Topology.**
   - A lead plus 3–5 workers (Claude's sizing). Use teams only where the work actually decomposes.
   - Short, bounded jobs go to sync `task` subagents: **`fork` for workers** that continue the lead's thread of work, **`isolated` for reviewers/verifiers**.
   - Long-lived teammates become async subagents (needs LangSmith Deployment) or separate deep agents on their own threads.
2. **Two-tier todo.**
   - *Private:* leave `write_todos` alone in every agent. It is the agent's scratch space, and deepagents isolates it on purpose.
   - *Team board:* one Store namespace with one item per task. Don't reuse `todos` for this: it has no reducer, replaces the whole list, and is excluded at the subagent boundary.
   - **The lead is the only writer** of `subject/description/blocked_by/files`. **Only the owner** writes `status/result`.
   - Start with the **lead assigning** tasks (Magentic style) rather than self-claim. I did not find a compare-and-set primitive in the LangGraph Store API, so verify before relying on one. If you need self-claim, back the board with a table that supports a conditional `UPDATE … WHERE status='pending' AND owner IS NULL` (the amux pattern), and add a lease for crash recovery.
3. **Show the board without flooding context.** A `before_model` middleware renders a compact board (`id | status | owner | blocked_by | subject`) into each agent's next model call. Full task descriptions are fetched only for the agent's own tasks.
4. **Messages.**
   - *Lead → worker:* the task description is the delegation contract: objective, output format, tools/sources, boundaries, owned files.
   - *Worker → lead:* the final message only, through `response_format`, e.g. `{status, summary≤2k tokens, artifacts[], open_questions[]}`. Artifacts go to the filesystem/Store, and only paths travel.
   - *Peer / lead → long-lived worker:* a mailbox, i.e. a `send_message(to, summary, body)` tool that writes to `("team", run, "inbox", to)`. An `InboxMiddleware.before_model` drains it into a single `<teammate_message>` user message at the recipient's next model call. This copies Claude Code's delivery semantics.
   - Reserve `update_async_task` for real course corrections, because it interrupts and restarts the child.
5. **Completion signal.** Add a lead-side `before_model` middleware that injects "board changes since your last turn": newly completed or failed tasks with their result summaries. This copies Claude's idle notification and saves the lead from polling `check_async_task`.
6. **Lead loop.** Each turn the lead fills in a Magentic-style Progress Ledger as structured output (§9). Count stalls; when the count passes 3, replan with the "what went wrong… avoid repeating" prompt.
7. **Done gate.** `board_update(status="completed")` is accepted only when there is evidence: a test passed, or an isolated verifier approved. This is the equivalent of Claude's `TaskCompleted` exit-code-2 hook.
8. **File ownership.** Each task lists the paths it may write. Enforce them with `FilesystemMiddleware` permissions or `CompositeBackend` routes, or give each worker its own sandbox. Never have two workers edit one file.
9. **Measure before you scale.** Run single-agent vs lead+3 on one parallelizable task and one sequential task from your own domain, and compare success rate, tokens and wall-clock time. Google's study predicts gains on the first and losses on the second; check that it holds for your tasks.

---

## 9. Example code you can adapt
_Untested. Verify against your deepagents/langchain versions. Context7 confirmed `AgentMiddleware` hooks, `runtime.store` in middleware, `ToolRuntime`, `lc_agent_name` in `runtime.config["metadata"]`, and `SubAgent.middleware`; `ToolRuntime.store` is assumed._

**a) Team board + mailbox tools and inbox middleware.** Based on Claude Code's inbox semantics [docs] and deepagents' middleware/Store APIs [docs].
```python
import time, uuid
from typing import Literal, TypedDict
from langchain.tools import tool, ToolRuntime
from langchain.agents.middleware import AgentMiddleware, AgentState
from langchain.messages import HumanMessage

RUN = ("team", "run-001")  # one namespace per team run

class BoardTask(TypedDict):
    id: str
    subject: str
    description: str        # lead-owned delegation contract
    owner: str | None       # lc_agent_name of the assignee
    status: Literal["pending", "in_progress", "blocked", "completed", "failed"]
    blocked_by: list[str]
    files: list[str]        # paths this task may write
    result: str | None      # owner-written: summary + artifact paths
    updated_at: float

def _me(rt: ToolRuntime) -> str:
    return rt.config.get("metadata", {}).get("lc_agent_name", "lead")

@tool
def board_list(runtime: ToolRuntime) -> str:
    """Team board: id | status | owner | blocked_by | subject."""
    rows = [i.value for i in runtime.store.search(RUN + ("tasks",), limit=200)]
    return "\n".join(f'{t["id"]} | {t["status"]} | {t["owner"]} | {",".join(t["blocked_by"])} | {t["subject"]}'
                     for t in rows) or "(empty)"

@tool
def board_update(task_id: str, status: str, result: str | None, runtime: ToolRuntime) -> str:
    """Update YOUR task's status/result. Only the task owner may call this."""
    item = runtime.store.get(RUN + ("tasks",), task_id)
    if item is None:
        return f"no task {task_id}"
    t = item.value
    if t["owner"] != _me(runtime):
        return f"refused: {task_id} is owned by {t['owner']}"
    t.update(status=status, result=result, updated_at=time.time())
    runtime.store.put(RUN + ("tasks",), task_id, t)  # one writer per row → no CAS needed
    return "ok"

@tool
def send_message(to: str, summary: str, body: str, runtime: ToolRuntime) -> str:
    """Message ONE teammate. Your plain text output is NOT visible to others; use this to communicate."""
    runtime.store.put(RUN + ("inbox", to), str(uuid.uuid4()),
                      {"from": _me(runtime), "summary": summary[:200], "body": body, "ts": time.time()})
    return "sent"

class InboxMiddleware(AgentMiddleware):
    """Drain this agent's inbox into one user message right before each model call."""
    def __init__(self, agent_name: str):
        super().__init__()
        self.agent_name = agent_name

    def before_model(self, state: AgentState, runtime) -> dict | None:
        ns = RUN + ("inbox", self.agent_name)
        items = sorted(runtime.store.search(ns, limit=50), key=lambda i: i.value["ts"])
        if not items:
            return None
        for i in items:
            runtime.store.delete(ns, i.key)
        text = "\n".join(
            f'<teammate_message from="{i.value["from"]}" summary="{i.value["summary"]}">\n'
            f'{i.value["body"]}\n</teammate_message>' for i in items)
        return {"messages": [HumanMessage(text)]}
```
Wire it with `create_deep_agent(..., tools=[board_list, send_message], middleware=[InboxMiddleware("lead")], subagents=[{"name": "worker-a", ..., "tools": [board_list, board_update, send_message], "middleware": [InboxMiddleware("worker-a")]}])`. Known gaps: drain-then-delete is not transactional, and lead-side task creation/assignment tools are omitted.

**b) Progress Ledger for the lead's structured output.** Copied word for word from AutoGen Magentic-One `_prompts.py` [src].
```
Is the request fully satisfied? (True if complete, or False if the original request has yet to be SUCCESSFULLY and FULLY addressed)
Are we in a loop where we are repeating the same requests and / or getting the same responses as before? Loops can span multiple turns…
Are we making forward progress? (True if just starting, or recent messages are adding value. False if recent messages show evidence of being stuck in a loop or if there is evidence of significant barriers to success…)
Who should speak next? (select from: {names})
What instruction or question would you give this team member? (Phrase as if speaking directly to them, and include any specific information they may need)
```
JSON keys, each `{reason: string, answer: …}`: `is_request_satisfied`, `is_in_loop`, `is_progress_being_made`, `next_speaker`, `instruction_or_question`.

Stall loop (MAF `_magentic.py`):
```python
if not is_progress_being_made.answer or is_in_loop.answer: stall_count += 1
else: stall_count = max(0, stall_count - 1)
if stall_count > max_stall_count:  # default 3
    reset_and_replan()
```
Replan prompt: "Please briefly explain what went wrong on this last run (the root cause of the failure), and then come up with a new plan that… avoids repeating the same mistakes." Task Ledger facts survey headings: "1. GIVEN OR VERIFIED FACTS 2. FACTS TO LOOK UP 3. FACTS TO DERIVE 4. EDUCATED GUESSES".

**c) Delegation contract for each task description.** From Anthropic's research system [blog]: "Each subagent needs an objective, an output format, guidance on the tools and sources to use, and clear task boundaries." Plus the deepagents reminder [docs]: "the supervisor only sees the final output".
```
OBJECTIVE: <one sentence>
OUTPUT FORMAT: final message = {status, summary (≤2k tokens), artifacts: [paths], open_questions: []}
TOOLS / SOURCES: <which to use, which to avoid>
BOUNDARIES: you may write only <files>; do NOT <neighbor task's job>
DONE WHEN: <checkable condition: test X passes / verifier approves>
Put every result in your FINAL message — the lead sees nothing else.
```

**d) Claude Code teams on-disk shapes, for reference** (3p, reverse-engineered).
```json
// ~/.claude/teams/{team}/inboxes/{agent}.json — entry
{"from":"lead","text":"...","summary":"5-10 words","timestamp":"…","color":"…","read":false}
// protocol message carried as stringified JSON in "text"
{"type":"idle_notification","from":"greeter","timestamp":"…","idleReason":"available"}
// ~/.claude/tasks/{team}/<id>.json
{"id":"1","subject":"…","description":"…","activeForm":"…","status":"pending","owner":null,"blocks":[],"blockedBy":[]}
```

---

## Practice → source quick reference

| Practice | Why it works | Source | Type |
|---|---|---|---|
| One lead owns the plan; workers never manage | Avoids planner disagreement and gives one validation point (error amplification 4.4 vs 17.2) | Claude teams docs; Google 2512.08296; Magentic | docs/paper/src |
| Two-tier todo: private scratch + team board | Sub-steps stay out of others' context; the board stays task-level | deepagents `_EXCLUDED_STATE_KEYS`; Claude Task tools | src/docs |
| One writer per field/row | No merge conflicts without locks | Ferryx status.yml; Claude self-claim | 3p/docs |
| Atomic claims (lock/CAS/git) | Two agents can't take one task | Claude file locking; amux CAS; C compiler git | docs/3p/blog |
| Explicit `blocked_by` + auto-unblock | Workers pick only actionable tasks | Claude teams docs | docs |
| Gate "done" on a check | Stops agents declaring victory early (MAST: not recognizing completion 12.4%, verification 17%) | Claude `TaskCompleted` exit 2; Anthropic feature list | docs/blog/paper |
| Push messages at the next turn boundary | No polling turns; low latency | Claude teams + cross-session docs; OpenAI mailbox | docs |
| Idle/completion notification carries the final answer | The lead never has to ask "done?" | Claude teams docs | docs |
| Summary line + body + artifact pointers | Small context cost; no telephone | Claude `SendMessage.summary`; Anthropic research system | docs/blog |
| Typed protocol messages | Machine-actionable control flow | OpenAI NEW_TASK/MESSAGE/FINAL_ANSWER; Claude protocol types | docs/3p |
| Point-to-point, no broadcast | Less noise and cross-influence | Claude docs (one per recipient); blackboard private response board | docs/paper |
| Fork for writers, isolated for verifiers | Writers need the implicit decisions; reviewers need a fresh view | LangChain 2026-09-08; Cognition 2026-04-22 | blog |
| Single-threaded writes; more agents add intelligence | Conflicting actions carry implicit decisions | Cognition | blog |
| Partition file ownership / own sandbox | Same-file edits overwrite each other | Claude teams docs; C compiler | docs/blog |
| Progress Ledger + stall counter + replan | Catches loops (MAST step repetition 15.7%) | Magentic / MAF | src |
| 3–5 teammates, 5–6 tasks each | Coordination cost grows with headcount | Claude teams docs | docs |
| Teams only for parallel work | Sequential tasks lose 39–70% | Google 2512.08296 | paper |
| Leases/heartbeats | A crashed worker's task returns to the queue | thereisnospoon | 3p |

---

## What's working (claimed)
- **Orchestrator-worker with filesystem artifacts.** Anthropic research: +90.2% [blog]. Claude Code teams and subagents are the shipped versions [docs].
- **Planner/worker/judge hierarchy** replaced a flat lock file and recovered throughput. The integrator role was removed because it "created more bottlenecks than it solved" (Cursor) [blog].
- **No orchestrator, with git locks plus a strong oracle** for a highly decomposable job: the C compiler, 16 agents [blog].
- **Clean-context reviewer agent:** about 2 bugs per PR, 58% severe (Cognition) [blog].
- **Magentic ledger with stall detection and replan**, shipped in MAF with human-in-the-loop hooks (`MagenticPlanReviewRequest`, `with_human_input_on_stall`) [docs/src].
- **Blackboard with private spaces:** LbMAS scored 81.68 on average at the second-lowest token cost [paper]. Request-broadcast/volunteer improved end-to-end success by 13–57% [paper].
- **Coordinating swarm vs independent agents for vulnerability hunting:** 266 vs 21 findings, though at about 4× the tokens (Anthropic 2026) [blog].

## What's broken / contested
- **Broadcast in Claude Code teams.** Current docs say "send one message per recipient". Teardowns from Feb–Apr 2026 describe a broadcast, so it was likely removed or changed. [docs vs 3p]
- **`TeamCreate` / `TeamDelete` tools.** Only third-party sources mention them. Current docs say the team is generated automatically at session start, so they are probably superseded. [3p vs docs]
- **Role prompts.** Anthropic 2026 found they didn't help; MAST found role *specification* gave +9.4%. My reading: specify boundaries and contracts, skip personas.
- **Swarm vs supervisor.**
  - For decentralized: LangChain (June 2025) found swarm slightly beat supervisor because of the telephone effect, and Google found decentralized best on BrowseComp-Plus (+9.2% vs +0.2%).
  - For centralized: Google found centralized has lower error amplification (4.4 vs 7.8) and wins Finance-Agent, and Cognition calls swarms "mostly a distraction".
  - So the best topology depends on the task.
- **Coordinate vs keep agents independent.** Google: independent agents amplify errors most (17.2×). Anthropic 2026: the newest models avoid conflicts "by hardly working together", while Sonnet 5 shares code at high throughput. Coordination quality depends on the model.
- **deepagents async completion: push or pull?** Docs say the supervisor "does not poll" (it uses check/list). An Oct 2026 issue mentions "delayed async task notifications". Unverified.
- **Fork mode and `todos`.** Unclear whether a forked child receives the parent's `todos` as state. It probably sees the `write_todos` tool messages in its inherited history (inference).
- **Cursor:** flat locking failed. Optimistic concurrency was "simpler and more robust", but "With no hierarchy, agents became risk-averse."
- **MAST:** fixing communication protocols alone is "often insufficient" for misalignment failures.

## Numbers worth verifying
All numbers below were measured and reported by their source unless marked as an estimate.

| Number | What | Source |
|---|---|---|
| +90.2% | Multi-agent research vs single-agent Opus 4 | Anthropic 2025-06-13 |
| 80% / 95% | Variance explained by token usage / by three factors | Anthropic 2025-06-13 |
| 4× / 15× | Agent / multi-agent tokens vs chat | Anthropic 2025-06-13 |
| ~7× | Claude Code teams' tokens in plan mode | Claude costs docs |
| ~2× | Teams' token use (estimate) | claudecodecamp (3p) |
| 800K / 1.2M+ | Team of 3 / 5 (unsourced estimate) | prg.sh (3p) |
| 16 agents, ~2,000 sessions, ~$20K, 100K LOC, 2B input / 140M output tokens | C compiler | Anthropic 2026-02-05 |
| 45 agents. 266 vulns / 27M tokens vs 21 / 6.5M. 12 in common | Swarm vs independent | Anthropic 2026-08-13 |
| +80.8% (blog/body: +80.9%) | Finance-Agent, centralized | Google 2512.08296 |
| −39.1% to −70.1% | PlanCraft, multi-agent variants | Google 2512.08296 |
| −3.5% mean (95% CI −18.6% to +25.7%) | All benchmarks | Google 2512.08296 |
| 1.0 / 4.4 / 5.1 / 7.8 / 17.2 | Error amplification: single agent / centralized / hybrid / decentralized / independent | Google 2512.08296 |
| 58 / 285 / 263 / 515% | Token overhead: independent / centralized / decentralized / hybrid | Google 2512.08296 |
| ~45%, β=−0.404 | Capability ceiling above which multi-agent stops helping | Google 2512.08296 |
| 87% | Predictor picks the best architecture on held-out configurations | Google blog 2026-01-28 |
| 41.77 / 36.94 / 21.30% | MAST v2 category totals: spec / misalignment / verification | MAST v2 |
| 15.7 / 13.2 / 12.4 / 11.8% | Top failure modes in MAST v3 (1,642 traces) | MAST v3 |
| +9.4% | ChatDev with better role specifications | MAST |
| 2 bugs/PR, 58% severe | Devin Review | Cognition 2026-04-22 |
| 20 → 2–3 | Effective throughput of 20 agents under a flat lock file | Cursor 2026-01-14 |
| 81.68 | LbMAS average score (vs ChatEval 80.56) | arXiv 2507.01701 |
| +13–57% | End-to-end gain, blackboard request/volunteer | arXiv 2510.01285 |
| 67% fewer tokens | Subagents vs skills, multi-domain tasks | LangChain 2026-01-14 |
| 3 / 6 | Default `max_concurrent_subagents` (Responses / Agents API) | OpenAI docs |
| 6 / 1 | Codex `max_threads` / `max_depth` defaults | Codex docs (2026-05 snapshot) |
| 25 / 20 | Managed Agents max child threads / predefined agents | Claude platform docs |
| 50 | Claude cross-session receive queue cap | Claude docs |
| 20 | `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` default | Agent SDK docs |
| 3 | MAF `max_stall_count` default | MAF source |
| 900 s | Practitioner lease default | thereisnospoon (3p) |

## Next moves
- **Experiment:** build §9a (board + inbox) on deepagents with a lead and 3 workers. A/B it against a single deep agent on one parallelizable and one sequential task from your bench, measuring success rate, tokens and wall-clock time. Separately, compare the lead-assigns and self-claim variants.
- **Verify before building:**
  1. The deepagents changelog v0.6 → v0.7.28, for async completion notifications and the `StoreBackend` namespace requirement.
  2. Whether LangGraph `BaseStore` has any conditional put or CAS.
  3. The full https://code.claude.com/docs/en/agent-teams page; this leg read it through search highlights.
- **Follow-up search:** MetaGPT's publish-subscribe message pool (primary source not read), and 2026 papers on structured inter-agent messaging (AOrchestra, AdaptOrch, PSMAS — seen only in a secondary survey).

## Sources
### Exa: LangChain / deepagents / LangGraph
- deepagents `subagents.py` (excluded keys, return path, fork): https://github.com/langchain-ai/deepagents/blob/main/libs/deepagents/deepagents/middleware/subagents.py [src]
- Parallel todo isolation test: https://github.com/langchain-ai/deepagents/blob/6c2d559b/libs/deepagents/tests/unit_tests/test_subagents.py [src]
- `TodoListMiddleware` / `Todo` schema: https://github.com/langchain-ai/langchain/blob/master/libs/langchain_v1/langchain/agents/middleware/todo.py ; https://reference.langchain.com/python/langchain/agents/middleware/todo/TodoListMiddleware [src/docs]
- Subagents docs: https://docs.langchain.com/oss/python/deepagents/subagents [docs]
- Async subagents: https://docs.langchain.com/oss/python/deepagents/async-subagents ; PR #1758 https://github.com/langchain-ai/deepagents/pull/1758 ; issue #2440 https://github.com/langchain-ai/deepagents/issues/2440 [docs/src]
- Backends / memory: https://docs.langchain.com/oss/python/deepagents/backends ; https://docs.langchain.com/oss/python/deepagents/memory ; `state.py` https://github.com/langchain-ai/deepagents/blob/main/libs/deepagents/deepagents/backends/state.py [docs/src]
- Todo-list frontend: https://docs.langchain.com/oss/python/deepagents/frontend/todo-list [docs]
- Multi-agent patterns: https://docs.langchain.com/oss/python/langchain/multi-agent ; handoffs …/multi-agent/handoffs ; subagents …/multi-agent/subagents [docs]
- Supervisor migration: https://docs.langchain.com/oss/python/migrate/langgraph-supervisor ; swarm README https://github.com/langchain-ai/langgraph-swarm-py/blob/main/README.md [docs]
- Graph API reducers / `Send`: https://docs.langchain.com/oss/python/langgraph/use-graph-api [docs]
- Organizing context in a multi-agent harness (2026-09-08): https://www.langchain.com/blog/organizing-context-in-a-multi-agent-harness [blog]
- Choosing the right multi-agent architecture (2026-01-14): https://www.langchain.com/blog/choosing-the-right-multi-agent-architecture [blog]
- Benchmarking multi-agent architectures (2025-06-10) and how/when to build (2025-06-16): https://www.langchain.com/blog/benchmarking-multi-agent-architectures ; https://www.langchain.com/blog/how-and-when-to-build-multi-agent-systems [blog]
- Agent Server A2A: https://docs.langchain.com/langsmith/server-a2a ; RemoteGraph https://docs.langchain.com/langsmith/use-remote-graph [docs]
- PyPI: https://pypi.org/project/deepagents/
### Exa: Anthropic / Claude
- Agent teams: https://code.claude.com/docs/en/agent-teams [docs]
- Agents overview / comparison: https://code.claude.com/docs/en/agents [docs]
- Tools reference: https://code.claude.com/docs/en/tools-reference ; env vars https://code.claude.com/docs/en/env-vars ; interactive mode https://code.claude.com/docs/en/interactive-mode ; hooks https://code.claude.com/docs/en/hooks ; costs https://code.claude.com/docs/en/costs [docs]
- Cross-session messaging: https://code.claude.com/docs/en/cross-session-messaging [docs]
- Subagents: https://code.claude.com/docs/en/sub-agents ; SDK https://code.claude.com/docs/en/agent-sdk/subagents ; SDK todo tracking https://code.claude.com/docs/en/agent-sdk/todo-tracking [docs]
- Managed Agents: https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration ; …/session-threads ; …/reference [docs]
- Multi-agent research system (2025-06-13): https://www.anthropic.com/engineering/multi-agent-research-system [blog]
- Effective context engineering (2025-09-29): https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents [blog]
- Effective harnesses for long-running agents (2025-11-26): https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents [blog]
- Building a C compiler (2026-02-05): https://www.anthropic.com/engineering/building-c-compiler [blog]
- Multi-agent systems research (2026-08-13): https://www.anthropic.com/research/multiagent-systems [blog]
- Teardowns: https://www.claudecodecamp.com/p/claude-code-agent-teams-how-they-work-under-the-hood ; https://www.claudecodecamp.com/p/how-agent-teams-actually-work ; https://antonch.me/en/posts/claude-agent-teams/ ; https://oikon48.dev/en/blog/claude-agent-teams/ ; https://prg.sh/notes/Claude-Code-Agent-Teams [3p]
### Exa: industry + research
- Scaling agent systems: https://arxiv.org/abs/2512.08296 ; blog https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/ [paper/blog]
- MAST: https://arxiv.org/html/2503.13657v3 ; v2 https://arxiv.org/pdf/2503.13657v2 [paper]
- Magentic-One prompts: https://raw.githubusercontent.com/microsoft/autogen/main/python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_magentic_one/_prompts.py [src]
- MAF Magentic: https://github.com/microsoft/agent-framework/blob/be8d2619/python/packages/orchestrations/agent_framework_orchestrations/_magentic.py ; https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/magentic [src/docs]
- A2A spec: https://a2a-protocol.org/latest/specification/ ; https://a2a-protocol.org/latest/ [docs]
- OpenAI Responses multi-agent: https://developers.openai.com/api/docs/guides/responses-multi-agent ; Agents API multi-agent https://developers.openai.com/api/docs/guides/agents-api/multi-agent [docs]
- OpenAI Agents SDK handoffs: https://openai.github.io/openai-agents-python/handoffs/ ; https://openai.github.io/openai-agents-python/ref/handoffs/ [docs]
- Codex subagents (2026-05-24 snapshot): https://web.archive.org/web/20260524042439/https:/developers.openai.com/codex/subagents [docs]
- Google ADK multi-agents: https://github.com/google/adk-docs/blob/5331a07f/docs/agents/multi-agents.md ; https://adk.dev/tutorials/agent-team/ [docs]
- Cognition: https://cognition.com/blog/dont-build-multi-agents (2025-06-12) ; https://cognition.com/blog/multi-agents-working (2026-04-22) [blog]
- Cursor scaling agents (2026-01-14): https://cursor.com/blog/scaling-agents [blog]
- Blackboard: LbMAS https://arxiv.org/abs/2507.01701 ; https://arxiv.org/html/2510.01285v2 [paper]
- Practitioner boards: https://ferryx.dev/blog/leader-worker-agent-orchestration/ ; https://thereisnospoon.org/docs/guides/coordinate-agents/ ; https://amux.io/guides/multi-agent-orchestrator-architecture/ ; survey (unverified) https://www.flowhunt.io/blog/multi-agent-ai-system/ [3p]

## Method notes
- **Legs run:** three parallel Exa legs (LangChain, Anthropic, industry/research), about 42 Exa calls in total. Reddit and YouTube were skipped at the user's request.
- **Coverage limits:**
  - Several pages were read only through search highlights, including the Claude agent-teams page.
  - In each leg, one large search result was lost to tool output limits.
  - Most official docs pages are undated; the dates given are publication dates where shown.
- **Not covered:** MetaGPT primary source, ADK transfer-scope flags, deepagents JS parity, LangSmith "agent inbox" (not found).
- **Code sketch:** API names were checked against Context7 (`/langchain-ai/deepagents`, `/websites/langchain_oss_python_deepagents`). The sketch itself has not been run.
