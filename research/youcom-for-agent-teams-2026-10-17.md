# You.com for our agents: where it adds value beyond default web search (Oct 2026)
_scope: You.com as of 2026-10-17, generic lens, Exa web research plus a hands-on API test • generated 2026-10-17_
_source tags: **[E]** = found through Exa (URL in Sources) · **[T]** = our own test on 2026-10-17. Every number is labeled **measured** (we ran it), **vendor** (You.com's own claim) or **3p** (someone else's benchmark)._

**How to read this.** "Our agents" means token-wise (Claude Code and Codex coding agents plus the Guild agents `pr-decision`, `trace-to-memory`, `session-retro`, `workflow-canonizer`, `loop-breaker`) and the lead + worker team designed in `research/agent-teams-coordination-2026-10-17.md` §8. The skill-discovery test in §3 was run by us and is the strongest evidence here. Vendor numbers are marketing until someone else reproduces them. The use-case table in §4 is my synthesis and **has not been tested** beyond §3.

---

## TL;DR
1. **Don't pick You.com as the default search for coding agents on quality.** On the one independent board built for coding agents (100 held-out docs tickets), You.com ranks 11th of 14 with fetch (55.0% vs Exa deep 83.0%) and 13th of 14 without (41.3% vs Perplexity 77.3%) [E, 3p]. It is the fastest with fetch (638 ms) and costs $5 per 1k. We already have Exa MCP and Claude's built-in WebSearch.
2. **Its distinctive product is the Research API.** One call runs a whole research agent with:
   - five effort tiers, from $12 to $1,200 per 1k calls;
   - `output_schema`, which returns typed JSON;
   - `source_control`: allow or deny up to 500 domains, plus freshness and country filters;
   - background mode with polling or an SSE stream.

   This helps **non-research** agents most. Any agent can embed a bounded research step and get back a typed result, without our team running its own research sub-team. Research sub-teams cost about 15× the tokens of chat in Anthropic's numbers [agent-teams brief].
3. **Skill discovery works through the Research API but not through plain search** [T, measured]:
   - Plain search found the canonical skill repo only when the product was named in the query.
   - The Research API at `deep` returned the canonical repo, the right install command and the right update date for both hard cases, in 20–26 s at about $0.10 per call.
   - It does **not** vet results. It ranked a 1-star repo #2 and marked it "official", and search surfaced a 0-star fork titled "The official Agent Skills".
4. **Best fit for token-wise: feed the memory, don't replace it.** Research once, store the result as a versioned Senso doc, and let every later agent read Senso. Candidates:
   - cold-start lessons
   - skill picks for new agents
   - re-checking lessons that may have gone stale

   That is token-wise's own thesis ("never twice") applied to paid web research.

---

## 1. What You.com is now
You.com moved from consumer search to an API-first platform during 2025–26 [E: guptadeepak]. As of today [E: you.com/docs/choose-the-right-api]:

| API | Use | Returns | Latency | List price |
|---|---|---|---|---|
| Web Search `POST ydc-index.io/v1/search` | ranked web + news results | snippets, or `extraction_mode: highlights` / `full_page` | retrieval only | $5 / 1k calls (up to 100 results); full page +$1 / 1k pages |
| Contents `POST ydc-index.io/v1/contents` | page text for known URLs | Markdown / HTML | ≤ `crawl_timeout` (default 10 s) | $1 / 1k pages |
| Answer `POST api.you.com/v1/answer` | one-pass cited answer | Markdown + citations with verbatim excerpts | p50 2.67 s | $5 / 1k |
| Research `POST api.you.com/v1/research` | multi-step cited research | Markdown or `output_schema` JSON + sources | `lite` <10 s · `standard` 10–30 s · `deep` <120 s · `exhaustive` <300 s · `frontier` background only, p50 300 s | $12 · $50 · $100 · $450 · $1,200 per 1k |
| Finance Research | cited finance answers (licensed S&P data) | same shape as Research | <120 s / <300 s | $110 / $500 per 1k |

Rules that change how you call it [E: docs]:
- `output_schema` does not work with `lite`, and `frontier` requires `background: true` (otherwise HTTP 422).
- Finance Research has no background mode and does not accept `source_control`.

**MCP server** [E: you.com/docs/agents/mcp-server]:
- **Endpoints:** hosted at `https://api.you.com/mcp`, also runnable locally with `npx @youdotcom-oss/mcp`. It is listed in the Anthropic MCP Registry as `io.github.youdotcom-oss/mcp`.
- **Six tools:** `you-search`, `you-contents`, `you-research`, `you-finance`, `you-balance`, `you-discover`. There is **no `you-answer` tool**; the Answer API is REST only.
- **Free profile:** `?profile=free` needs no key and allows 100 queries per day, but only for `you-search` and `you-discover`.
- **Per-agent fencing:**
  - The `?tools=` allowlist (or the `X-Allowed-Tools` header) limits which tools an agent sees. The default list leaves out research and finance.
  - `/mcp/research` and `/mcp/finance` are single-tool endpoints, so you can give them their own key and track their spend separately.
- **Host-pinned parameters:** the host can attach `_meta["com.you.com/search"]` or `X-Search-*` headers to each tool call. These override what the model asks for, for example a fixed `include_domains` list.
- **Agent Skills:** `youdotcom-oss/agent-skills` ships the skills `you-web`, `you-research`, `you-finance` and `you-discover` [E: docs/agents/plugins].

**Other features** [E]:
- SOC 2 and account-level zero data retention.
- x402 / MPP machine payments: an agent with a funded wallet can pay per call without an API key.
- Connectors for Merge Agent Handler (9 tools, 2026-10-09) and Paperclip (2026-10-15). Paperclip lets each agent's You.com tools be set to Allowed, Ask first or Off, with per-agent budgets and an audit log.
- Integrations with Pydantic AI, LangChain (`langchain-youdotcom`), n8n, Sim and Composio.
- **No first-party Guild integration found.** Guild supports custom REST and MCP integrations instead [E: docs.guild.ai/services/create-an-integration].

Contradiction: guptadeepak.com says You.com "does not yet ship" MCP. That is outdated; the docs above show the hosted server.

## 2. How good it is (benchmarks)

### Web search
| Benchmark (who ran it) | Result |
|---|---|
| openbenchmarks web-search-for-coding-agents: 100 held-out enterprise docs tickets, model fixed (`gpt-5.6-sol`), 3 runs [3p] | **Search + fetch:** You.com 55.0 ± 1.7, 11th of 14. Exa deep 83.0, Exa auto 81.7, TinyFish 79.0, Perplexity high 77.7. You.com is the fastest at 638 ms, but its median of 42,806 tokens per ticket is the 2nd-highest on the board. **Search only:** You.com 41.3 ± 3.1, 13th of 14, vs Perplexity low 77.3. |
| NEEDLE: 22 engines, 5 verticals, as of 2026-10-17 [3p] | You.com 60% of the ceiling, vs Keenable 76, Exa 68, Brave LLM Context 66. Finance 84%, AgenticRare 38%. p50 499 ms, $5 / 1k. |
| AgentPick, production telemetry [3p] | You.com Search 85.8% success, 1,085 ms, from only 930 events. Exa 98.9%, Brave 100%. |
| You.com, highlights mode [vendor] | SimpleQA 95.17% (81.68% with snippets). FRAMES 82.04%. |
| Braintrust eval, 1,329 questions, published by You.com [vendor-published] | With Claude Sonnet 5: You.com highlights cost $0.0747 per question at 79.23% accuracy, vs $0.1148 at 78.78% for Claude's built-in search (−35% cost). With GPT-5.6 Terra: −11% cost. |

**Reading.** You.com's search is fast, cheap and good at single-fact lookup. For coding-agent documentation lookups it is mid-pack or worse.

### Research
| Benchmark (who ran it) | Result |
|---|---|
| DRACO: 100 long-form tasks, run by **Valyu, a competitor**, with scripts open at `github.com/valyuAI/valyu-benchmarks` [3p] | You.com `exhaustive` 53.0% at $450 / 1k. Valyu Heavy 72.7% at $2,500. Parallel Ultra8x 51.2% at $2,400. Tavily pro 38.8%. Exa deep-reasoning 25.9% at $15. You.com `frontier` was not tested (it was sales-gated at the time). |
| You.com, July 2026 [vendor] | DeepSearchQA 86.61% (`frontier`), F1 94.35%. FinSearchComp_t2 89.95%. The agent can run up to 1,000 turns and 10 M tokens on one query, and `frontier` can drive a browser and run code. |

**Reading.** Among research APIs with public prices, You.com gets good quality for the money. It beats Parallel's top tier on DRACO at about a fifth of the price.

## 3. Test: can it find the right skill for a new agent? [T, measured 2026-10-17]
**Method.**
- Free MCP `you-search` with 10 results and snippets.
- REST search with `boost_domains: ["github.com","skills.sh"]`.
- Research API at `deep`, with an `output_schema` that asks for `{skill_name, repo_url, publisher, is_official_publisher, install_command, last_updated, why_it_fits}`. One run was restricted to github.com and skills.sh with `source_control.include_domains`.
- The prompt asked for the canonical upstream repo over directories and forks.
- The canonical answers come from skills installed on this machine and from the GitHub API.

| # | Need (as phrased) | Mode | Canonical | Result |
|---|---|---|---|---|
| 1 | ClickHouse schema / query skill (product named) | free search | `ClickHouse/agent-skills` | **#1 ✓.** Its SKILL.md and launch blog follow. #6 is `vybenetwork/clickhouse-agent-skills`: a **0-star fork titled "The official Agent Skills…"** |
| 2 | "find the root cause of a bug before fixing" | free search | `obra/superpowers` systematic-debugging | Found only through a directory page (cookiesforai, #1). No canonical repo URL. |
| 3 | "make videos programmatically with React" | free search | `remotion-dev/skills` | **✗** Blogs and a third-party repo. |
| 4 | create / edit pptx | free search | `anthropics/skills` pptx | #9, below 8 directories and blogs. |
| 5 | React / Next.js performance, `freshness=month` | free search | `vercel-labs` vercel-react-best-practices | Named only through directory and blog pages; no vercel-labs repo URL. |
| 2b | #2 with domain boost | REST search | | `addyosmani/agent-skills`, NousResearch hermes. No obra. |
| 3b | #3 with domain boost | REST search | | `remotion-dev/remotion/packages/skills` at #5. A third-party `remotion-skill` at #1. |
| 2c | #2 | Research `deep` + schema, 20 s | | `mattpocock/skills` diagnosing-bugs, then **`obra/superpowers` systematic-debugging ✓**, then addyosmani. Install commands are correct. |
| 3c | #3 | Research `deep` + schema, 26 s | | **`remotion-dev/skills` #1 ✓**, with `npx skills add remotion-dev/skills`. |
| 3d | #3 limited to github.com + skills.sh | Research `deep` + schema, 23 s | | **`remotion-dev/skills` #1 ✓** |

**Checked against the GitHub API (measured).**

Freshness was accurate:
- The returned dates match `pushed_at`: `remotion-dev/skills` 2026-10-16, `obra/superpowers` 2026-10-10.
- Every returned URL exists.

Adoption and safety were not judged:

| Repo | Stars | Note |
|---|---|---|
| obra/superpowers | 301k | |
| mattpocock/skills | 295k | |
| addyosmani/agent-skills | 108k | |
| remotion-dev/skills | 5.3k | |
| reactvideoeditor/react-video-editor-agent-skills | **1** | returned as #2 with `is_official_publisher: true` |
| Gang-of-Beads/remotion-killer-skill | **0** | |
| vybenetwork/clickhouse-agent-skills | 0 | a **fork** |

**Cost (measured).** The `you-balance` tool reported a drop from 1000 to 969 for three `deep` research calls plus two REST searches. 31 units matches the list price in cents ($0.30 + $0.01), but the unit is my inference from Merge's tool description, not confirmed by You.com. The free-profile searches took 1.4–4.4 s.

**Why vetting matters.**
- Snyk (Feb 2026) analyzed 3,984 skills from clawhub.ai and skills.sh. It confirmed 76 malicious payloads; 13.4% of skills had at least one Critical issue; 91% of the malicious ones used prompt injection; and "popularity is not a safe proxy for security" [E: 3p].
- skills.sh indexes about 1.37 M skills and SkillsMP more than 2 M. Both crawl GitHub with no published review [E: agenticskills.io, 3p].

**Verdict.** Yes, with the Research API and a vetting step after it. Proposed pipeline (untested end to end):
1. **Find:** call the Research API at `deep` with `output_schema`, to get a shortlist with URLs, install commands and dates. Cost about $0.10.
2. **Rank:** use the GitHub API for stars, fork flag, `pushed_at` and owner type. Drop forks, and drop repos with few stars unless they come from the vendor's own org. Add install counts from skills.sh.
3. **Vet:** run Semgrep over the skill folder before installing (Snyk `agent-scan` covers prompt injection, which code scanners miss).
4. **Remember:** write `SKILL-PICK-<need>-V1` to Senso with the shortlist, the signals and the reason for the choice. The next agent reads that and doesn't search again.

**Alternatives to compare before committing (not tested here):**
- The skills.sh `find-skills` meta-skill (`vercel-labs/skills`, 3.3 M installs reported).
- The Skillselion keyless API, `GET skillselion.com/api/v1/listings?q=…&type=skill`, and its MCP server. It ranks by install count and refreshes daily.

Registries carry adoption signals but only cover what they have indexed. You.com covers the open web, including brand-new skills and the blog posts that explain them.

## 4. Where it adds value in our agents (synthesis, not tested beyond §3)

| Where | Use | API | Why You.com specifically | List cost |
|---|---|---|---|---|
| `senso-lessons` miss / `trace-to-memory` on a **new** Semgrep rule or CI error | **Cold-start lesson.** token-wise only learns from failures it has already seen, so the first occurrence gets no help. Research the fix pattern from authoritative sources and save `LESSON-…-V1` labeled `source: external, unverified`. Promote it after an agent's fix passes. | Research `standard`/`deep` + `include_domains` (semgrep.dev, owasp.org, cwe.mitre.org, github.com/advisories, the library's docs) + `output_schema` shaped like a lesson | Domain sandboxing plus typed output in one call | $0.05–0.10 per lesson |
| Lead, when it creates a new worker role (agent-teams §8) | **Skill pick** (§3) | Research `deep` + schema | Shown to work in §3 | ~$0.10 per need |
| Lead, when it needs breadth-first research | **Use the Research API as the research worker.** Its output already matches the worker → lead contract `{status, summary, artifacts}` through `output_schema`. Background mode with `task_id` behaves like an async subagent. | Research, `background: true` | A flat price per call, instead of our own model running a research sub-team at about 15× chat tokens | $0.05–0.45 per task |
| Scheduled refresh (ClickHouse refreshable MV → Guild) | **Re-check stale lessons and runbooks.** For each lesson that makes an external claim, ask "is this still true?" with `freshness` and the schema `{still_valid, evidence_url, changed_since}`. Write V(n+1) if not. | Research `standard` | Freshness filters and typed output | $0.05 per lesson |
| `loop-breaker` on thrash caused by an external error (toolchain, dependency, CI) | Search the exact error string, limited to the last month or year | Search (highlights) or Answer | Cheap and fast | $0.005 per call |
| `pr-decision` Slack question | Add one cited line on what upstream says, e.g. "known false positive?" or "is there an upstream fix?" | Answer (REST) | One pass, p50 2.67 s, verbatim excerpts | $0.005 per call |
| Isolated verifier | Fact-check the external claims in a worker's output | Answer / Search | Citations come with verbatim excerpts you can audit | $0.005 per call |

**Not recommended:**
- **Default documentation lookup for coding agents.** Exa scores far higher on the coding board (§2).
- **The memory bench.** The bench deliberately gives agents no web tools (`bench/README.md` "Isolation"), and adding web search to one arm would mix it into the memory on/off comparison. Bench data also suggests web search would rarely help: 4 of the 8 silent setup failures were a test runner missing from PATH (`bench/STATUS.md`, measured). That is a local problem, not a knowledge problem.
- **Finance Research.** No use case here.

**Does it only help the research agent?** No. Plain search is commodity infrastructure: any agent can use it, and it is not the best for code docs. The Research API is the part that is hard to rebuild, and its main users are the agents that are **not** research agents. They get a research step that returns a typed result, limited to sources the host chooses and capped by a fixed price per call. In token-wise terms, You.com answers "what does the world say" and Senso answers "what worked for us". Its main value is feeding the second, so each question is paid for once.

## 5. Integration notes (if we adopt)
- **Key:** stored in `~/.config/oct9/youcom.env` (`YDC_API_KEY`, mode 600), outside the repo. `tracing/lib/redact.mjs` already masks `ydc-sk-…` through its `sk-` rule; verified: the output is `ydc-[REDACTED]`.
- **Fencing:**
  - Coding agents connect to `https://api.you.com/mcp?tools=you-search,you-contents`.
  - Lesson writers connect to `/mcp/research` with their own key.
  - Pin trusted domains with host `_meta` / `X-Search-*` headers, so the model can't widen them.
- **Tracing gap:** `.claude/settings.json` PostToolUse and PostToolUseFailure match only `Edit|Write|Bash`. MCP calls would therefore never reach ClickHouse. Add the You.com MCP tool prefix to the matcher to measure spend and outcomes per session.
- **Guild:** register `https://api.you.com/mcp/research` (or the REST endpoints) as a custom MCP or REST integration. This can't be tested yet: all Guild runs have failed since 2026-10-11 with "token balance exhausted" (`bench/STATUS.md`).

## Numbers worth verifying
| Number | Label | Source |
|---|---|---|
| You.com 55.0% / 41.3% task completion (coding board) | 3p | openbenchmarks |
| 638 ms fastest search + fetch | 3p | openbenchmarks |
| NEEDLE 60% overall | 3p | keenableai.github.io/needle |
| SimpleQA 95.17%, FRAMES 82.04% | vendor | you.com highlights post, 2026-09-01 |
| −35% cost vs Claude Sonnet 5 built-in search | vendor-published (Braintrust) | same |
| DRACO 53.0% at $450 / 1k | 3p, competitor-run | valyuAI/valyu-benchmarks |
| DeepSearchQA 86.61%, FinSearchComp 89.95% | vendor | you.com, 2026-07-22 |
| Research 20–26 s at `deep`; $0.31 for the whole test | measured | §3 |
| 76 malicious skills of 3,984; 13.4% Critical | 3p | Snyk, 2026-02-05 |

## Next moves
- **Experiment 1 (about $0.10):**
  - Pick one Semgrep rule that already has a verified `LESSON-semgrep-<rule>`.
  - Generate a cold-start lesson for it with the Research API, limited to semgrep.dev, owasp.org and cwe.mitre.org.
  - Diff it against the verified lesson. If it matches the fix pattern, wire it into `senso-lessons` as the fallback when no lesson exists.
- **Experiment 2 (about $1–2):** ten skill needs with known answers. Compare You.com Research `deep`, skills.sh `find-skills` and the Skillselion API on two scores: canonical answer at #1, and how often forks or clones appear.
- **Follow-up search:** Guild custom MCP integration auth (bearer header vs OAuth) for `api.you.com/mcp/research`.

## Sources
### Exa: You.com (docs and blog)
- https://you.com/docs/welcome · https://you.com/docs/choose-the-right-api.md · https://you.com/docs/guides/search.md · https://you.com/docs/agents/mcp-server · https://you.com/docs/agents/plugins.md · https://you.com/docs/changelog · https://you.com/docs/llms.txt · https://you.com/docs/api-reference/research/v1-research.md
- Research API launch: https://you.com/resources/research-api-by-you-com · controls: https://you.com/resources/new-you-dot-com-research-api-controls · frontier (2026-07-22): https://you.com/resources/the-ydc-research-api-frontier-tier-reaches-a-new-level-of-state-of-the-art-performance · DeepSearchQA method: https://you.com/resources/achieving-sota-on-deepsearchqa
- Highlights + Braintrust: https://you.com/resources/highlights-parameter-web-search-api · Unite.AI coverage: https://www.unite.ai/you-com-web-search-highlights-reaches-95-17-on-simpleqa/
- Paperclip connector (2026-10-15): https://you.com/resources/ydc-paperclip-connector · Merge Agent Handler (2026-10-09): https://you.com/resources/ydc-merge-agent-handler-connector · Sapiom: https://you.com/resources/real-time-web-intelligence-for-autonomous-agents-ydc-sapiom · Finance Research: https://you.com/resources/introducing-the-finance-research-api-agentic-research-no-infra-required · ARI: https://you.com/resources/introducing-ari-the-first-professional-grade-research-agent-for-business
- Pydantic AI M&A desk example: https://www.linkedin.com/posts/youdotcom_its-common-to-see-cited-answer-demos-fall-activity-7500553121337606147-XQL9 · Baseten / Answer API: https://www.linkedin.com/posts/youdotcom_excited-about-our-partnership-with-baseten-activity-7496644959429877760-VkI2
### Exa: third-party benchmarks
- https://github.com/openbenchmarks-labs/web-search-for-coding-agents · https://openbenchmarks.com/web-search-for-coding-agents/fastest-search-api · https://openbenchmarks.com/web-search
- https://keenableai.github.io/needle/results/ · https://agentpick.dev/benchmarks/web-search · https://guptadeepak.com/research/web-search-apis-ai-agents-2026/
- DRACO: https://www.valyu.ai/blogs/introducing-deepresearch · https://github.com/valyuAI/valyu-benchmarks/blob/main/draco/outputs/full/README.md
### Exa: skill ecosystem
- https://research.snyk.io/blog/agent-skills-threat-landscape/ · https://agenticskills.io/ai-skills-directories · https://www.skills.sh/ · https://skillselion.com/llms-full.txt · https://trustedskills.dev/ · https://www.skillsdirectory.com/
### Exa: Guild
- https://docs.guild.ai/services/create-an-integration · https://docs.guild.ai/platform/agent-hub/integrations

## Method notes
- **Legs run:** Exa only (user choice; Reddit and YouTube skipped), about 9 Exa calls, plus direct You.com API tests:
  - 5 free MCP searches
  - 2 REST searches
  - 3 Research `deep` calls
  - 2 balance checks
- **Partial reads:** two large Exa results were read through a filtered excerpt (`jq` + `grep`), not in full.
- **Senso was not used:** the CLI rejected the API key (`senso kb get-content` → authentication failed), so no shared memory was read or written.
- **Ground truth for §3:** skills installed on this machine and the GitHub REST API. "Canonical" means the upstream author's or vendor's own repo.
