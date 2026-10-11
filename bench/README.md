# bench: does shared, verified memory make a team's coding agents better at everyday work?

Headless Claude Code runs real tasks from three public benchmarks, one workflow each. Every task
is graded by the benchmark's own check, run by the harness after the agent stops; the agent never
sees the check.

| Workflow | Benchmark | Pass means |
|---|---|---|
| Get a repo building and its tests passing | SetupBench (microsoft/SetupBench @041a412) | the task's `success_command` prints `Setup successful` (exit 0 for dependency conflicts) |
| Upgrade a dependency that breaks the build | BUMP (chains-project/bump images) | in a fresh container the agent's diff makes `mvn clean test` green, every pre-bump test still exists and passes, the dependency stays at the new version, no skip/disable/Java-level shortcut |
| Fix a security finding | PatchEval-Verified (ghcr.io/patcheval-cve) | in fresh containers the agent's diff, minus test-file changes, defeats the PoC exploit (`fix-run.sh`) and keeps the unit tests green (`unit_test.sh`) |

## Arms

The only difference between arms is memory. Same model, flags, turn and time limits, task order and caches.

- `off`: no memory.
- `ungated`: every lesson the extractor writes is stored and served (how most agent memory works).
- `gated`: a lesson is stored only if its task passed the official check with tests untouched, and the
  trace shows the failure it names followed by the step that resolved it. A lesson shown three times
  without a pass is retired.

Lessons live in Senso (folder `bench-memory`, one subfolder per run). The agent sees them through
Claude Code hooks: up to 2 lessons at session start (searched with the task brief) and up to 2 after
a failed tool call (searched with the error), at most 8 lookups per task. Search is scoped to the
run's own lessons.

## Isolation

`claude -p` with `--setting-sources ''`, an empty MCP config, no web tools, no session persistence,
CLAUDE.md files and auto memory off. Bash is routed into the task container by a PreToolUse hook;
file tools are limited to the repo, which is bind-mounted at the same path on host and container.

## Run

```bash
node bench/validate.mjs --workload deps --set pilot      # drop tasks whose reference fails
node bench/run.mjs --workload setup --set pilot --arm off   --seed 1 --model sonnet
node bench/run.mjs --workload setup --set pilot --arm gated --seed 1 --model sonnet
node bench/report.mjs                                    # per-arm table; --json for raw numbers
npm run bench:test
```

A run resumes where it stopped (finished tasks are skipped, the lesson index is kept). Exit code 3
means the subscription usage limit was hit; re-run the same command after the reset.

Setup tasks share pull-through caches (`tw-apt`, `tw-pypi`, `tw-npm` on the `tw-bench` network) so
download speed does not decide results. Workspaces stay in `bench/.work/` (gitignored); results,
traces and lessons in `bench/results/<run>/`.

## Metrics

Per task: pass, tampered, turns, agent time, tool calls, failed calls, failure signatures, lessons
shown and written. `report.mjs` adds the repeat-failure rate (failed calls whose signature already
failed in an earlier task of the same run), pass rate in the second half of the run, and per-task
wins and losses against `off` for the same seed.
