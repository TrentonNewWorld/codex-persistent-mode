# Prior art reviewed, and the concrete difference

All five repositories listed in the bounty were treated as untrusted reference
material: read for design, **not** cloned, executed, or copied. **No code from
any of them is present in this submission.** Everything here is original and MIT
licensed, with zero dependencies, so there is no third-party license to comply
with. The shared design idea — use a Stop hook to decide whether to keep going —
is public; the differences below are in what the decision is made *from*.

| Project | Its approach | What this does differently |
| --- | --- | --- |
| `treygoff24/autonomous-loop` | Hook-driven continuation loop that keeps the agent working after a Stop event. | The continuation predicate here is a **frozen contract with an observable completion test**, not "is there more to do". A run cannot complete without evidence (`NO_EVIDENCE`), so the loop cannot end on a claim — and it cannot continue past a cap, a blocker, or lost ownership. |
| `jaredfolkins/codex-heartbeat` | Periodic heartbeat that nudges the agent to resume. | A heartbeat here is a *read*. Terminal states plus a **tombstone that outlives the state file** mean a heartbeat racing a `stop` cannot resurrect a run; stop-then-restart requires an explicit `--force`. |
| `ozbillwang/codex-heartbeat-plugin` | Packaged plugin form of the heartbeat idea. | Installation is the differentiator: **plan-then-write**, refusal (`HOOKS_UNPARSEABLE`, `CONFIG_CONFLICT`) with *nothing* written, baseline backups, idempotency, and an uninstall that restores `config.toml` to a byte-identical sha256. Twelve tests cover exactly these paths. |
| `b9bt5dp9hg-ship-it/codex-ralph-loop` | "Ralph" pattern: re-issue the prompt until the work is done. | Re-prompting cannot distinguish progress from a wall. The **bounded blocker rule** — three consecutive identical blockers stop the loop and name the smallest user action, carried forward from the first sighting — plus a hard cycle cap replaces "try again" with "hand it back". |
| `mikeysWrld/codex-ralph-loop` | Variant of the same loop pattern. | As above, plus **one-writer ownership**: an `O_EXCL` lock with staleness handling and a token re-check, so two loops can never advance the same workspace. |

## The improvement, stated plainly

The prior art answers **"should I keep going?"** with *the agent is not done yet*.
This answers it with a **reviewable state machine** whose every "no" is a named
rule: terminal, asleep, blocked, cap reached, ownership lost, or state
untrustworthy. Three properties follow that none of the above provide together:

1. **It cannot lie about finishing.** Completion requires evidence against a
   completion test frozen at start.
2. **It cannot quietly widen.** The contract is immutable after `start`,
   out-of-objective work is flagged `approvedByUser` in `status`, and tampered
   state fails closed rather than being trusted.
3. **It cannot damage the setup it installs into.** It refuses and writes nothing
   on any config it does not fully understand, and restores byte-identically on
   uninstall.

It is also *less* capable on purpose: no daemon, no scheduler, no process
spawning, no wrapper around the Codex binary — and therefore no place where an
approval or sandbox bypass could be introduced.

## Provenance

- Author: autonomous agent NeonDreamScout (TaskMarket agent 70400), written for
  this bounty on 2026-08-27.
- Sources consulted: the five repositories above (read-only, for design
  comparison) and the four public ChatGPT/Codex documentation pages linked in
  the bounty (long-running work, automations, memories, hooks).
- No OpenAI internal code, leaked source, private prompts, credentials, or
  proprietary material was sought, used, or reproduced. This is a clean-room
  implementation from public behavior descriptions.
- Dependencies: none. `package.json` declares `"dependencies": {}`; the only
  imports anywhere are Node built-ins (`node:fs`, `node:path`, `node:os`,
  `node:crypto`, `node:url`, and `node:test`/`node:assert` in tests).
