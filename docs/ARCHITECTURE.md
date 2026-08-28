# Architecture

## Components

```
bin/persist.js  ──> src/lifecycle.js ──> src/state.js   (contract, durability, integrity)
                                     └─> src/lock.js    (one-writer ownership)
                    src/install.js                      (plan-then-write config merge)
                    src/paths.js                        (everything resolved from CODEX_HOME)
```

Roughly 900 lines, no dependencies, no network, no daemon.

## State ownership

One file, `$CODEX_HOME/persistent/state.json`, is the single source of truth. It
holds exactly one record: the frozen contract, the lifecycle state, the cycle
count, the follow-up queue, the evidence list, and the current blocker.

Writes are atomic (write `state.json.tmp-<pid>`, then rename), so an interrupted
write leaves the previous good state rather than a truncated file. Reads validate
JSON shape, schema `version`, required fields, and a SHA-256 checksum computed
over a key-sorted canonical serialization, so key reordering does not produce a
false mismatch. Every failure is a distinct error code, and every one of them
makes continuation return false.

`$CODEX_HOME/persistent/events.log` is append-only JSONL: one line per lifecycle
transition, timestamped. It exists for the user to audit, not for the program to
read back.

## Lifecycle

```
                 start
                   |
                   v
   sleep <---> [ awake ] ---- complete(evidence) ---> [ completed ]  (terminal)
     ^             |  ^
     |             |  |  unblock (explicit user act)
     v             v  |
 [ asleep ]     [ blocked ] <--- 3x same blocker, or cycle cap
     |               |
     +----- stop ----+-------------------------------> [ stopped ]   (terminal)
                                                       + tombstone
```

`completed` and `stopped` are terminal: `wake` refuses. `stop` additionally
writes `stopped.json`, a tombstone that outlives `state.json`, so a heartbeat
that races a stop cannot resurrect the run by recreating state — and even a fresh
`start` must pass `--force`.

## Continuation mechanism

`shouldContinue()` is the entire decision, in one auditable function. It returns
`{continue, reason, nextAction, completionTest, cyclesRemaining}` and refuses on:
tombstone present, unreadable state (any code), terminal state, asleep, blocked,
cycle cap reached, or lock-token mismatch. There is no path that returns true by
default.

The installed `Stop` hook runs `node bin/persist.js should-continue --json`.
Exit `0` means continue, `3` means do not. **The hook does not launch Codex, pass
flags, or execute work** — it reports a verdict. That is what keeps this from
being an approval-bypassing wrapper: there is no wrapper.

## Concurrency control

`src/lock.js` uses an `O_EXCL` create (`flag: 'wx'`) as the mutex, so ownership
is decided by the filesystem rather than by a check-then-create race. The lock
records a random token, the pid, the resolved workspace, and a heartbeat time.

- A live or recently-heartbeating owner gives `LOCKED`.
- An unparseable lock gives `LOCK_UNREADABLE` and fails closed. Never assume free.
- A lock whose pid is gone *and* whose heartbeat is older than 15 minutes is
  reclaimed, recording `reclaimedFrom` so the displacement stays visible.

The state file stores the lock token it was created with. `shouldContinue()`
re-checks that the on-disk lock still carries that token, so a runner that lost
ownership stops advancing instead of writing into a workspace someone else owns.

## Proactive wakeups

Delegated to Codex's documented primitives (scheduled tasks / heartbeats). Each
invocation is just another `should-continue` call, so a quiet run is a cheap read
that answers "no" and prints one line — no spam, no daemon, and nothing that
keeps a machine awake. See `docs/LIMITATIONS.md` for exactly how far this was
verified.

## Safety gates

Enforced at the point of writing rather than by convention:

- **Contract freeze** — set once at `start`; no command edits contract fields.
- **Scope discipline** — queue items outside the objective must carry
  `approvedByUser`, and `status` prints the flag.
- **Consequential pause** — a blocker is the mechanism: report it, and after
  three identical sightings the loop stops and names the smallest user action.
- **Runaway caps** — cycles (default 25, max 500) and queue length (200). The
  cycle cap is not clearable by `unblock`.
- **Honest completion** — `complete` requires evidence, so "done" cannot be a
  promise; without an argument it raises `NO_EVIDENCE`.
- **Secret rejection** — `assertNoSecrets` gates every write to state and log.
- **Fail closed** — every unreadable-state path returns "do not continue".

## Installer

`install()` computes the plan for `hooks.json` **and** `config.toml` before
writing either, so a conflict in the second cannot leave the first modified.
`hooks.json` is merged as JSON (our entry matched by `id`, everything else
untouched); `config.toml` gets a fenced managed block appended rather than being
parsed and re-emitted, because round-tripping TOML destroys comments and ordering
and would break "preserved byte-for-byte". Originals are copied to
`persistent/backups/` first.

`uninstall()` prefers exactness: if the current file is still precisely what
install would have produced from the saved baseline, the baseline bytes are
restored verbatim. Otherwise it surgically removes only our hook entry and fenced
block, preserving edits the user made after installing.
