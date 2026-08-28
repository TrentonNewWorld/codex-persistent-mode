# Limitations — what is genuinely implemented, and what is not

Written to be believed, not to sell. Where this package depends on Codex, it
says so.

## Verified by the submitted evidence

Everything in this list is exercised by `node --test "test/**/*.test.js"`
(33 tests, all passing) and/or `bash test/e2e-transcript.sh`, both captured in
`docs/TEST-RUN.txt` and `docs/TRANSCRIPT.txt`:

- One active record per `CODEX_HOME`, bound to one objective and one workspace.
- Contract freeze; `wake` restores it byte-identically.
- `sleep` / `wake` / `stop` semantics, including terminal states that refuse to wake.
- Tombstone: a stop cannot be undone by recreating state; restart needs `--force`.
- One-writer lock, stale reclaim, unreadable-lock fail-closed, ownership-loss halt.
- Missing / malformed / tampered / version-mismatched state each fail closed.
- Bounded blocker rule at 3 consecutive identical blockers, with the user action carried forward.
- Cycle cap that `unblock` cannot clear.
- Secret rejection before any write; nothing secret-shaped reaches disk.
- Additive install; refusal on unparseable or conflicting config with **nothing** written; idempotency; uninstall restoring `config.toml` to a **byte-identical** sha256.

## Not verified, and honestly labelled

**Codex CLI `0.145.0` compatibility is a compatibility report, not a test run.**
The requester's target environment is macOS with Codex desktop and Codex CLI
`0.145.0`. This work was authored and tested on **Windows 11 with Node v24.19.0**,
where Codex `0.145.0` was not available to the worker. Consequences:

- The **33 automated tests and the end-to-end transcript are real** and were run
  on this machine. They test this package's own logic and its file-level
  integration with a `CODEX_HOME` directory tree.
- The **hook contract is written to the documented public shape** (a `Stop`-event
  entry in `hooks.json` with an `id`, a `command` argv array, and a timeout) taken
  from the public hooks documentation. It has **not** been observed firing inside
  Codex `0.145.0`. If `0.145.0`'s schema differs — a different event name, a
  string command instead of argv, a different file location — the fix is confined
  to `hookEntry()` in `src/install.js`, a single function, and the merge/refusal
  logic around it is unaffected.
- Nothing else in the package depends on Codex internals: the lifecycle, state,
  locking, and installer are exercised end-to-end without Codex present.

**Proactive wakeups are delegated, not implemented.** This package does not
schedule anything, run a daemon, or keep a machine awake. Occasional
continuation is expected to come from Codex's own supported primitives —
scheduled tasks / heartbeats and "Prevent sleep while running" — each of which
calls `persist should-continue` and honors the verdict. That means:

- If the Codex app is closed and no scheduled task fires, **nothing continues.**
  State is preserved and the next `wake`/heartbeat resumes it; there is no
  background process of ours filling the gap. This is deliberate — a daemon
  would be exactly the kind of authority expansion the bounty forbids.
- Notification delivery is whatever Codex provides; we emit a verdict and a
  reason, not a notification.

**Goals and Memories are not reimplemented.** Bounded continuity here is the
contract plus a follow-up queue plus an evidence list. It does not read, write,
or synchronize Codex Memories, and it makes no claim to.

**The state checksum is integrity, not authentication.** It detects accidental
corruption and casual hand-editing. Anyone with write access to `$CODEX_HOME`
can recompute it — and could edit the hook itself regardless. See
`docs/THREAT-MODEL.md`.

**Cross-`CODEX_HOME` collisions are not detected.** The lock lives under
`CODEX_HOME`. Two runners with *different* `CODEX_HOME`s aimed at the same
workspace directory will not see each other.

**Blocker identity is string equality** on the summary. A caller that rewords
the blocker every cycle defeats the 3-strike rule. Pass a stable summary.

**"Preserve existing dirty work"** is honored by omission: this package never
writes inside the workspace, never runs git, and never cleans anything. It
cannot destroy uncommitted work because it does not touch the workspace at all.
It also therefore cannot *protect* dirty work from whatever the loop itself
does — that remains Codex's approval boundary.

**macOS-specific behavior is untested.** File modes (`0600`), `O_EXCL`
semantics, and `process.kill(pid, 0)` liveness checks are POSIX-portable and are
used in their portable forms, but the suite was run on Windows. There is no
platform-conditional code to diverge.

## Not done, on purpose

Per the bounty's rules, this submission installs nothing on the requester's
machine, creates no accounts, accepts no terms, spends nothing, contacts no one,
publishes and deploys nothing, and adds no dependency to audit.
