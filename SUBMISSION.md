# codex-persistent-mode — evidence bundle

**What this is:** a working, installable, dependency-free recreation of a safe
global Persistent mode for Codex, with 33 automated tests and a reproducible
end-to-end transcript, both actually run and captured here. Not a design doc.

**Repository:** https://github.com/TrentonNewWorld/codex-persistent-mode
(public, MIT). The exact submitted tree is the immutable tag `v1.0.1`, commit
`2ccd682b8edd15c39a060bcd8ad5c9ffa2479a44`:
https://github.com/TrentonNewWorld/codex-persistent-mode/tree/v1.0.1

**Attached:** `codex-persistent-mode-v1.0.1.zip` — the same tree, complete with
source, tests, docs and evidence. Because `main` could move after submission,
the archive and the `v1.0.1` tag are the authoritative artifacts; review either.

**On CI:** `ci/github-actions-tests.yml` is a ready GitHub Actions matrix
(ubuntu-latest + macos-latest) that runs the 33 tests, the end-to-end transcript,
the zero-dependency assertion and the no-network assertion. It is deliberately
*not* installed as a live workflow: the token used to publish this repository
lacks the `workflow` OAuth scope, so no green CI run exists and none is claimed.
Copy it to `.github/workflows/` in your own fork to reproduce independently.

Run everything with no install and no dependencies:

```bash
unzip codex-persistent-mode-v1.0.1.zip && cd codex-persistent
node --test "test/**/*.test.js"    # 33 tests, ~0.6s
bash test/e2e-transcript.sh        # full lifecycle against a temp CODEX_HOME
```

---

## 1. The design decision that matters

**Continuation is a pull, not a push.** This package never spawns Codex, never
passes a CLI flag, and never executes work. It owns a durable contract and
answers one question on demand:

```
$ persist should-continue
CONTINUE - objective incomplete, authorized, and within cycle cap    exit 0
DO NOT CONTINUE - blocked: staging DB credentials rejected (401)     exit 3
```

A Codex `Stop` hook asks and branches on the exit code. Because there is no
wrapper around the Codex binary, **there is no place an approval or sandbox
bypass could be introduced** — that is a structural property, not a promise.

## 2. Lifecycle commands

```
persist install [--dry-run] / uninstall [--keep-state]
persist start --objective T --workspace DIR --completion-test T [--max-cycles N] [--scope S] [--source URL] [--force]
persist status [--json]      objective, queue, evidence, blocker, next action, awake?
persist sleep [--reason T]   stop advancing, keep everything
persist wake                 resume the SAME contract
persist stop [--force]       permanent; writes a tombstone
persist should-continue      hook entry point; exit 0 continue / 3 do not
persist cycle | enqueue ITEM [--approved] | blocker --summary T [--action T] [--new-route]
persist unblock [--note T] | complete --evidence T | where
```

`--json` everywhere. Exit codes: 0 ok, 1 refused (prints `[CODE] reason`), 2 usage,
3 do-not-continue. Everything resolves from `$CODEX_HOME`, so an isolated
`CODEX_HOME` is a fully isolated install — which is how the acceptance tests run.

## 3. Acceptance tests, mapped to evidence

Every row is exercised by the attached suite. `L` = `test/lifecycle.test.js`,
`I` = `test/install.test.js`, `T` = `docs/TRANSCRIPT.txt`.

| Requester's acceptance test | Where | Result |
| --- | --- | --- |
| Fresh install succeeds; existing config preserved byte-for-byte except a reviewed additive merge | I: "existing hooks.json keeps every unrelated hook", "existing config.toml is preserved byte-for-byte", "fresh install creates…" | pass — the original config bytes are asserted to be a literal prefix |
| Starting creates exactly one active record bound to one objective/task/workspace | L: "start creates exactly one active record…" | pass — a second `start` raises `ALREADY_ACTIVE` |
| Incomplete objective continues after a normal Stop event | L: "an incomplete objective continues across a Stop event" | pass — verdict read from disk by a fresh instance |
| Verified completion releases the loop; later heartbeats do not revive it | L: "verified completion releases the loop…" | pass — `wake` raises `TERMINAL`; `complete` without evidence raises `NO_EVIDENCE` |
| `sleep` prevents work while preserving state; `wake` resumes the same contract | L: "sleep prevents work while preserving state…" | pass — contract asserted deep-equal after wake; queue survives |
| `stop` terminates permanently unless the user explicitly starts a new run | L: "stop is permanent…" | pass — tombstone; restart requires `--force` |
| Session restart restores only the intended bounded context | L: "session restart restores only the bounded contract" | pass — state key set asserted exactly |
| Two simultaneous runners cannot both own the same workspace | L: "two simultaneous runners…", "a stale lock…", "an unreadable lock fails closed" | pass — `O_EXCL`; `LOCKED`; fail-closed on unreadable |
| Missing, malformed, tampered, or version-incompatible state fails closed | L: "missing, malformed, tampered and version-incompatible state all fail closed" | pass — 4 distinct codes; all return do-not-continue |
| Repeated identical blockers trigger the bounded rule, not infinite retry | L: "the same blocker three cycles running…", "a genuinely new route resets…", "a repeated blocker carries forward the user action" | pass — stops at 3, names the smallest user action, `wake` cannot bypass it |
| No dangerous approval/sandbox bypass is invoked | I: "the installed hook never passes a sandbox or approval bypass" | pass — asserts no `--yolo`, `--dangerously-bypass-approvals-and-sandbox`, `bypass`, `full-auto`, `--ask-for-approval never` appears in anything installed |
| No secrets or raw private memory appear in state or logs | L: "secrets are rejected before they can reach state or logs" | pass — rejected pre-write; a rejected contract creates no state and takes no lock |
| Uninstall returns the isolated config to baseline without deleting unrelated files | I: "uninstall returns a pre-existing configuration to its exact baseline", "uninstall preserves unrelated files and edits made after install" | pass — `config.toml` sha256 identical to baseline (also shown in T) |
| The full automated suite passes with a clean reproducible command | `node --test "test/**/*.test.js"` | **33 passing, 0 failing** (`docs/TEST-RUN.txt`) |

Additional guards beyond the stated list: a hard cycle cap that `unblock`
refuses to clear (`CAP_EXCEEDED`), a 200-item queue cap, an append-only JSONL
event log, `0600` file modes, atomic state writes, and install refusing to write
*anything* when either target file is unparseable or conflicting.

## 4. Transcript highlights (`docs/TRANSCRIPT.txt`, run on this machine)

```
$ persist blocker --summary "staging DB credentials rejected (401)"   [3rd time]
blocker recorded (x3)
Same blocker 3 cycles running: advancing stopped, user action needed:
  rotate STAGING_DB_URL, then tell me
$ persist should-continue     -> DO NOT CONTINUE - blocked: ...          exit 3
$ persist wake                -> [BLOCKED] Waking would not change the blocker.  exit 1
$ persist complete --evidence "npm test -> 41 passing, 0 skipped"
$ persist should-continue     -> DO NOT CONTINUE - run is completed      exit 3
$ persist wake                -> [TERMINAL] Run is completed...          exit 1
$ persist start ...           -> [STOPPED_TOMBSTONE] ... --force to confirm  exit 1
$ persist uninstall           -> config.toml: restored from baseline (byte-identical)
config.toml baseline sha: a4329c01e183e1b6167e81359d084524adeed25a456f2be56eb6afe85623bfaa
config.toml after    sha: a4329c01e183e1b6167e81359d084524adeed25a456f2be56eb6afe85623bfaa
BYTE-IDENTICAL: yes
```

## 5. Documents in the archive

- `README.md` — install, lifecycle, safety-gate table, recovery.
- `docs/ARCHITECTURE.md` — lifecycle diagram, state ownership, continuation,
  concurrency, wakeups, installer.
- `docs/THREAT-MODEL.md` — prompt injection, malicious workspace files, corrupted
  state, duplicate runners, stale locks, infinite loops, approval bypass, secret
  leakage, unsafe external effects; each with mitigation **and residual risk**.
- `docs/LIMITATIONS.md` — see §6.
- `docs/COMPARISON.md` — the five prior-art repos, what each does, and the
  concrete difference; plus provenance.
- `docs/TEST-RUN.txt`, `docs/TRANSCRIPT.txt` — captured evidence.

## 6. Honest limitations

- **Codex `0.145.0` compatibility is a compatibility report, not a test run.**
  This was authored and tested on **Windows 11, Node v24.19.0**; Codex CLI
  `0.145.0` and macOS were not available to me. The 33 tests and the transcript
  are real and were run here — they cover this package's logic and its
  file-level integration with a `CODEX_HOME` tree. The hook entry is written to
  the documented public shape (a `Stop` entry with `id`, argv `command`,
  timeout) but has **not** been observed firing inside `0.145.0`. If that
  schema differs, the fix is confined to one function, `hookEntry()` in
  `src/install.js`; nothing else touches Codex internals.
- **Proactive wakeups are delegated, not implemented.** No daemon, no scheduler,
  nothing that keeps a machine awake — deliberately, since that would be the
  authority expansion the bounty forbids. If the app is closed and no scheduled
  task fires, nothing continues; state is preserved for the next wake.
- **The state checksum is integrity, not authentication.** It catches corruption
  and casual hand-editing. Anyone who can write `$CODEX_HOME` can recompute it —
  and could edit the hook anyway. Said plainly rather than dressed up with an
  HMAC whose key would live in the same directory.
- **Goals/Memories are not reimplemented**; continuity here is the contract,
  queue, and evidence list only.
- Two runners with *different* `CODEX_HOME`s aimed at one workspace are not
  detected; blocker identity is string equality on the summary.

## 7. Compliance

Clean-room from the public documentation and behavior descriptions cited in
`docs/COMPARISON.md`. No OpenAI internal code, leaked source, private prompts,
or proprietary material was sought or used. The five prior-art repositories were
read for design only — **no code from them appears here**; everything is original
and MIT licensed. **Zero dependencies** (`"dependencies": {}`; only Node
built-ins are imported), zero network calls, zero telemetry — verifiable with
`grep -rnE "https?://|fetch\(|node:http|node:net|child_process" src/ bin/`,
which returns no call sites.

Nothing was installed on the requester's machine. No accounts, terms, payments,
contacts, publications, deployments, or transactions were involved.
