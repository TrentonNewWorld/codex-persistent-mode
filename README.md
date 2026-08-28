# codex-persistent-mode

An auditable, installable recreation of the behavior publicly described as Codex
"Persistent mode": Codex keeps advancing **one authorized objective** until the
user puts it to sleep, carries bounded state across turns and sessions, and can
be resumed by a supported wakeup mechanism — without ever widening its own
authority.

Zero runtime dependencies. Node >= 20. Everything lives under `$CODEX_HOME`, so
an isolated `CODEX_HOME` is a fully isolated install.

## The one design decision that matters

**Continuation is a pull, not a push.** This package never spawns Codex, never
passes a CLI flag, and never executes work. It owns a durable *contract* and
answers exactly one question on demand:

```
$ persist should-continue
CONTINUE - objective incomplete, authorized, and within cycle cap   # exit 0
DO NOT CONTINUE - blocked: staging DB credentials rejected (401)    # exit 3
```

A Codex `Stop` hook asks that question and branches on the exit code. Because
the decision is a pure read of reviewable state, the user can audit *why* the
loop continued at any point, and no code path exists that could bypass approvals
or sandboxing — there is nothing here that launches anything.

## Install

```bash
git clone <repo> && cd codex-persistent-mode
node --test "test/**/*.test.js"          # 33 tests, no install needed
node bin/persist.js install --dry-run     # show the exact plan, write nothing
node bin/persist.js install               # additive merge into $CODEX_HOME
```

Install is **fail-closed and additive**:

| Situation | Behavior |
| --- | --- |
| No `hooks.json` / `config.toml` | Creates them |
| Existing valid `hooks.json` | Appends one hook with `id: codex-persistent-mode`; every other key and hook is preserved |
| Existing `config.toml` | Appends a fenced managed block; the original bytes remain a literal prefix (comments and ordering intact) |
| `hooks.json` is not valid JSON | **Refuses**, `HOOKS_UNPARSEABLE`, writes nothing at all |
| `config.toml` already has a `[persistent_mode]` we did not write | **Refuses**, `CONFIG_CONFLICT`, writes nothing at all |
| Run twice | Idempotent — no duplicate hook, no duplicate block |

Both files are planned before either is written, so a conflict in the second can
never leave the first half-modified. Originals are copied to
`$CODEX_HOME/persistent/backups/` before any write.

## Lifecycle

```bash
persist start --objective "Make the failing integration suite green" \
              --workspace ~/src/app \
              --completion-test "npm test exits 0 with zero skipped integration tests" \
              --max-cycles 25

persist status              # objective, queue, evidence, blocker, next action, awake?
persist sleep               # stop advancing, keep everything
persist wake                # resume the SAME contract, unchanged
persist stop                # permanent; writes a tombstone
persist uninstall           # remove exactly what install added
```

Working commands a hook or skill calls between lifecycle events:

```bash
persist cycle                                     # record one inspect->act->verify pass
persist enqueue "fix the auth spec"               # follow-up from the objective
persist enqueue "refactor billing" --approved     # explicitly user-approved backlog
persist blocker --summary "..." --action "..."    # report an external blocker
persist unblock --note "creds rotated"            # explicit user clearance
persist complete --evidence "npm test -> 41 passing, 0 skipped"
```

`--json` on any command gives machine output. Exit codes: `0` ok, `1` refused
(with a `[CODE] reason`), `2` usage, and `3` from `should-continue` meaning "do
not continue".

## Safety gates, and where each is enforced

| Requirement | Enforcement |
| --- | --- |
| No approval/sandbox bypass | Nothing in this package execs Codex. The hook command is `node persist.js should-continue`. A test asserts no `--yolo` / `--dangerously-bypass-approvals-and-sandbox` string can appear in what we install. |
| Authority never widens | The contract is frozen at `start`. `wake` restores it and cannot edit it (asserted by test). Out-of-objective queue items must carry `approvedByUser`, and `status` shows the flag. |
| One writer per workspace | `O_EXCL` lockfile (`src/lock.js`). A second runner gets `LOCKED`. An unreadable lock fails closed rather than stealing the workspace. A stale lock is reclaimed only if the owning pid is gone *and* the heartbeat is older than 15 min, and the reclaim records whom it displaced. |
| Bounded blockers | The same blocker three consecutive cycles with no new route sets state `blocked`, stops advancing, and surfaces the smallest user action. `wake` refuses to paper over it; only `unblock` (an explicit user act) clears it. |
| Runaway guard | `--max-cycles` (default 25, hard max 500). Hitting it is terminal-ish: `unblock` refuses with `CAP_EXCEEDED`. Queue is capped at 200 items. |
| No resurrection | `complete` and `stop` are terminal, and `stop` writes a tombstone that outlives the state file, so a heartbeat racing a stop cannot recreate a run. Even `start` after a stop needs `--force`. |
| Fail closed on bad state | Missing / malformed / tampered (checksum mismatch) / version-mismatched state each throw a distinct code, and `should-continue` returns `false` for all of them. |
| No secrets stored | `assertNoSecrets` runs before every write to state or log and rejects private-key blocks, `sk-`/`ghp_`/`xox`/`AKIA` shapes, 32-byte hex, and `key=value` credential shapes. A rejected contract creates no state and takes no lock. |
| No hidden network | Zero dependencies, zero network calls, zero telemetry. `package.json` `dependencies` is `{}`. |

## Uninstall

```bash
persist uninstall               # also removes state
persist uninstall --keep-state  # keep the run record for inspection
```

If the config is still exactly what install produced from the saved baseline,
the **baseline bytes are restored verbatim** (verified by sha256 in
`docs/TRANSCRIPT.txt`). If the user edited the file after installing, we instead
surgically remove only our hook entry / fenced block and keep their edits.
Unrelated files are never touched.

## Recovery

| Symptom | Command |
| --- | --- |
| `[TAMPERED_STATE]` / `[MALFORMED_STATE]` | Inspect `$CODEX_HOME/persistent/state.json`, then `persist stop --force` and start again. |
| `[LOCKED]` but you know the owner is dead | Wait out the 15-minute stale window, or `persist stop --force`. |
| `[STOPPED_TOMBSTONE]` | Intentional. `persist start ... --force` to confirm a new run. |
| Lost track of what it is doing | `persist status`, then `$CODEX_HOME/persistent/events.log` (append-only JSONL). |

## Layout

```
bin/persist.js       CLI and exit codes
src/paths.js         every path, resolved from CODEX_HOME
src/state.js         schema v1, atomic write, checksum, secret rejection, fail-closed reads
src/lock.js          O_EXCL one-writer ownership, staleness, reclaim
src/lifecycle.js     the state machine and the shouldContinue() decision
src/install.js       plan-then-write additive merge + precise uninstall
test/                33 automated tests
test/e2e-transcript.sh  reproducible end-to-end run against a temp CODEX_HOME
docs/                architecture, threat model, limitations, prior-art comparison, evidence
```

MIT licensed. No third-party code was copied or adapted; see
`docs/COMPARISON.md` for the prior art reviewed and `docs/LIMITATIONS.md` for an
honest account of what is implemented versus what depends on Codex itself.
