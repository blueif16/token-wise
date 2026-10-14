# Memory bench: status and next steps (2026-10-14)

Shared memory for agents is Senso (see AGENTS.md). Its `CURRENT.md` and `AUDIT-memory-bench-vs-product-V1`
(node `0ce11c37-8e8e-4bfd-a968-a7553900f0fa`) hold the same story with more detail. This file is the
copy in git, for picking the work up on another machine.

## Goal

Prove, with public benchmarks and measured numbers, that **token-wise's own memory workflow** makes a
team's coding agents better at everyday work. Then send the result to Senso. Senso's bar is "the
marginal cost of a repeated outcome falls with cumulative verified usage", shown as memory on vs off on
the same agent, tasks and model.

Workflows (picked by the user): repo setup (SetupBench), breaking dependency upgrade (BUMP), security
fix (PatchEval-Verified).

**The system under test is the product pipeline**, not a lookalike written for the bench.

## Where things stand

### Proven (measured)
- The graders are trustworthy. Each check fails an untouched repo and passes a known-correct fix. The
  deps check catches a hidden `-DskipTests`, and the sec check hides the gold patch and PoC from the
  agent.
- Tasks whose own reference fails were dropped: deps 18/20 valid, sec 15/20 valid.
- Memory-off baselines (sonnet):

  | Workload | Pass | Turns | Notes |
  |---|---|---|---|
  | deps pilot | 18/18 | 7.6 | Too easy: there is nothing for memory to improve |
  | setup pilot | 21/30 | 4.1 | 8 of 9 failures are silent: the agent says "done" and the check then fails |
  | sec pilot | not run | | |

  Of the 8 silent setup failures, 4 are a test runner missing from the check's PATH (tox, tox, pytest,
  yarn). The other 4 are a full test suite that was never run.

### Not proven
- **Anything about memory.** The bench has never run token-wise's memory workflow. Bench agents start
  with `--setting-sources ''`, so they get no AGENTS.md, no CURRENT.md, no `senso-lessons` skill, no
  PLAYBOOK or RUNBOOK, no Semgrep Guardian and no ClickHouse tracing. Lessons came from a bench-only
  Haiku extractor (`lib/lessons.mjs`), and a hook pushed them into the session (`hooks/hook.mjs`). That
  substitute ran on only 4 tasks, on a harness that still had bugs.

### Broken right now
- **The product's Learn loop has been down since 2026-10-11 16:50 UTC at the latest.**
  - The ClickHouse detectors and webhooks work.
  - All 11 Guild runs from then to 2026-10-12 failed within 1 s with `Your token balance is exhausted.
    Please add your own API key to continue.` (measured).
  - The last memory doc was written 2026-10-10 00:21 UTC.
  - A session-retro trigger on 2026-10-13 01:05 UTC wrote no doc. The cause is unverified, because the
    Guild CLI on this machine has since logged out.

### Why the product pipeline can't be dropped into the bench unchanged
1. **No isolation between arms.** All 4 Guild prompts (loop-breaker, trace-to-memory, session-retro,
   workflow-canonizer) hardcode the team's Senso folder `11fcd627…` and read every trace, unfiltered.
2. **Timing.** Detectors refresh every 5 min with a 2 min settle and `LIMIT 1` per refresh. A lesson
   lands about 5–10 min after a task ends (guessed).
3. **loop-breaker would rarely fire.** It needs ≥3 failures within 10 min. The baselines had 16 failed
   calls across 30 setup tasks and 6 across 18 deps tasks (measured).
4. **The workflow types don't fit.** They are feature, bugfix, ci-fix, security-fix and other, and
   `other` writes nothing. Setup and dependency upgrades have no clear type (risk, untested).
5. **Silent failures stay invisible.** The only outcome-based signal is a failed CI run, and it can't
   see why the run failed (`LESSON-ci-failure-semgrep-V3`: "cause not visible in traces").
6. **The read side depends on the agent choosing to follow the skill.** In real sessions, about 3 of 6
   sessions with ≥3 failures in 10 min logged a lesson lookup (measured, session-level).

## What to try next (in order)

1. **Restore Guild** (user action): add an API key or top up the `blueif16~sandbox` workspace. Then
   `guild auth login`, and confirm that one triggered run ends DONE (`guild session get <id>`).
2. **Run the product inside the bench.** Each task session loads a bench copy of the product config:
   - AGENTS.md (with a per-run bench Senso folder), the `senso-lessons` skill, and the tracing hooks
     (`tracing/hook.mjs`, with repo tagged `bench/<run>/<arm>`)
   - Semgrep Guardian for the sec workload

   The bench's own extractor and injector become, at most, a "naive memory" comparison arm.
3. **Parameterize the Guild agents.** The Senso folder ID and a repo/run filter come from the trigger
   context instead of being hardcoded. These are new agent versions (`guild agent code blueif16~<agent>
   --output <dir>` to fetch, `guild agent save --publish` to ship).
4. **Make the official check visible to memory.** After `adapter.verify`, write a CI-like event with
   its result and the failing output, so the outcome path can learn from silent failures.
5. **Fire the real Guild agents synchronously in the bench.** After each task, insert the trigger rows
   (or call the API trigger) and wait for DONE before the next task starts. This tests the same prompts
   without the 5 min cadence. Test the detectors separately.
6. **Pick harder slices.** Run a short memory-off probe (about 10 tasks per slice) and keep a slice only
   if its pass rate is roughly 30–70% and its failures recur. Candidates:
   - BUMP: Jenkins core, enforcer upper-bound, javax→jakarta, log4j skew
   - the SetupBench full set
   - PatchEval clusters
   - Haiku as the agent model
7. **Verify, then A/B.** Check the pipeline end to end on 2–3 dev tasks first. Then freeze it and run
   off vs on over held-out tasks with ≥3 seeds. Do not launch long runs before steps 2–5 work.

Still open, outside the bench: rotate the ClickHouse password (it was pasted in chat once), and step 4
of DESIGN-agent-triggers-V1.

## Resuming on another machine

Branch `feat/memory-bench`. Baseline results are committed under `bench/results/`. That includes
per-task traces and transcripts for offline component tests. `v0/` is from the buggy harness and is
diagnostic only.

Not in git, so recreate these:

- **Tools.** Install node, docker, jq, and Semgrep (`uv tool install semgrep`). Also install the
  `claude` CLI logged in with the subscription, the `senso` CLI (authenticated), and the `guild` CLI
  (`guild auth login`). Run `npm install` so `prepare` sets the git hooks path.
- **Secrets.** `~/.config/oct9/clickhouse.env` is needed by the tracing hooks. Copy it privately and
  never commit or print it. `~/.config/oct9/slack.env` is optional.
- **SetupBench.** `git clone https://github.com/microsoft/SetupBench bench/vendor/SetupBench && git -C
  bench/vendor/SetupBench checkout 041a412`.
- **Caches.** Create network `tw-bench` with three containers, all with `--network tw-bench`:

  | Container | Image | Flags |
  |---|---|---|
  | `tw-apt` | `sameersbn/apt-cacher-ng:3.7.4-20220421` | `-v ~/.cache/token-wise-bench/apt:/var/cache/apt-cacher-ng` |
  | `tw-pypi` | `epicwink/proxpi:latest` | `-v ~/.cache/token-wise-bench/pypi:/cache`; args `--bind 0.0.0.0:5000 --threads 2 --no-control-socket` |
  | `tw-npm` | `verdaccio/verdaccio:5` | none extra |

- **Task images.** About 12 GB (guessed from the last pull). They are pulled on demand by
  `node bench/validate.mjs` and `node bench/run.mjs`.
- **Check the setup.** Run `npm run bench:test`, then `node bench/report.mjs`.
