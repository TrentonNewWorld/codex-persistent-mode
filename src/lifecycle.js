// The lifecycle state machine: start / status / sleep / wake / stop, plus the
// continuation decision a hook asks for on every Stop event.
//
// The most important property here is that continuation is a PULL, not a push:
// nothing in this package spawns Codex, passes flags, or widens authority.
// shouldContinue() returns a verdict and a reason; the Codex hook decides.
import fs from 'node:fs';
import path from 'node:path';
import * as S from './state.js';
import * as L from './lock.js';
import { paths } from './paths.js';

export const BLOCKER_LIMIT = 3; // same blocker 3 cycles running -> hand back to the user

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

export function appendEvent(file, event) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  S.assertNoSecrets(event, 'event log entry');
  fs.appendFileSync(file, JSON.stringify(event) + '\n', { mode: 0o600 });
}

export class Persistent {
  constructor({ env = process.env, clock = Date.now } = {}) {
    this.p = paths(env);
    this.clock = clock;
  }

  logEvent(action, detail) {
    appendEvent(this.p.log, Object.assign({ ts: nowIso(this.clock), action }, detail));
  }

  // A stop tombstone outlives the state file so a heartbeat that races a stop
  // cannot resurrect the run by recreating state.
  tombstone() {
    try {
      return JSON.parse(fs.readFileSync(this.p.tombstone, 'utf8'));
    } catch {
      return null;
    }
  }

  start({ objective, workspace, completionTest, scope, sources, maxCycles, force = false }) {
    const tomb = this.tombstone();
    if (tomb && !force) {
      throw new S.StateError(
        'STOPPED_TOMBSTONE',
        'A previous run was stopped at ' + tomb.stoppedAt +
          '. Starting again is an explicit user act: re-run with --force to confirm.'
      );
    }
    if (S.exists(this.p.state)) {
      // Read to classify: a terminal record may be replaced, a live one may not.
      const existing = S.read(this.p.state);
      if (!S.TERMINAL.includes(existing.state)) {
        throw new S.StateError(
          'ALREADY_ACTIVE',
          'Run ' + existing.runId + ' is already ' + existing.state + ' on "' + existing.contract.objective +
            '". Exactly one active record is allowed. Use sleep, stop, or status.'
        );
      }
    }
    const contract = S.newContract({
      objective,
      workspace,
      completionTest,
      scope,
      sources,
      maxCycles,
      now: nowIso(this.clock),
    });
    // Ownership is taken BEFORE state is written, so a losing racer never leaves
    // a state file behind.
    const holder = L.acquire(this.p.lock, { workspace: contract.workspace, now: this.clock() });
    const state = S.initialState(contract, nowIso(this.clock));
    state.lockToken = holder.token;
    try {
      S.write(this.p.state, state);
    } catch (err) {
      L.release(this.p.lock, holder.token);
      throw err;
    }
    fs.rmSync(this.p.tombstone, { force: true });
    this.logEvent('start', { runId: state.runId, objective: contract.objective, workspace: contract.workspace });
    return state;
  }

  status() {
    const tomb = this.tombstone();
    if (!S.exists(this.p.state)) {
      return {
        active: false,
        awake: false,
        tombstone: tomb,
        message: tomb ? 'Stopped. No active run.' : 'No Persistent mode run exists.',
      };
    }
    const state = S.read(this.p.state);
    return {
      active: !S.TERMINAL.includes(state.state),
      awake: state.state === S.STATES.AWAKE,
      runId: state.runId,
      state: state.state,
      objective: state.contract.objective,
      workspace: state.contract.workspace,
      completionTest: state.contract.completionTest,
      cycles: state.cycles,
      maxCycles: state.contract.maxCycles,
      queue: state.queue,
      evidence: state.evidence,
      blocker: state.blocker,
      repeatedBlockerCount: state.repeatedBlockerCount,
      nextAction: this.nextAction(state),
      owner: L.inspect(this.p.lock),
      tombstone: tomb,
    };
  }

  nextAction(state) {
    if (state.state === S.STATES.COMPLETED) return 'none - objective complete';
    if (state.state === S.STATES.STOPPED) return 'none - stopped';
    if (state.state === S.STATES.ASLEEP) return 'none - asleep; wake to resume';
    if (state.state === S.STATES.BLOCKED) {
      return 'paused for user: ' + (state.blocker ? state.blocker.summary : 'unknown blocker');
    }
    return state.queue.length ? state.queue[0].item : 'verify: ' + state.contract.completionTest;
  }

  mutate(fn, action) {
    const state = S.read(this.p.state);
    const next = fn(state);
    next.updatedAt = nowIso(this.clock);
    next.lastAction = action;
    S.write(this.p.state, next);
    this.logEvent(action, { runId: next.runId, state: next.state });
    return next;
  }

  sleep(reason = 'user requested') {
    return this.mutate((s) => {
      if (S.TERMINAL.includes(s.state)) {
        throw new S.StateError('TERMINAL', 'Run is already ' + s.state + '; nothing to put to sleep.');
      }
      s.state = S.STATES.ASLEEP;
      s.sleepReason = String(reason);
      return s;
    }, 'sleep');
  }

  wake() {
    return this.mutate((s) => {
      if (S.TERMINAL.includes(s.state)) {
        throw new S.StateError('TERMINAL', 'Run is ' + s.state + ' and cannot be woken. Start a new run explicitly.');
      }
      if (s.state === S.STATES.BLOCKED && s.blocker && !s.blocker.resolvedByUser) {
        throw new S.StateError(
          'BLOCKED',
          'Blocked on: ' + s.blocker.summary + '. Waking would not change the blocker. ' +
            'Resolve it and clear it with unblock, which is an explicit user act.'
        );
      }
      // wake restores the SAME contract: nothing here may edit contract fields.
      s.state = S.STATES.AWAKE;
      delete s.sleepReason;
      return s;
    }, 'wake');
  }

  stop({ force = false } = {}) {
    if (!S.exists(this.p.state)) {
      if (force) {
        this.writeTombstone('force-stop with no state');
        return { state: S.STATES.STOPPED, note: 'No state existed; tombstone written.' };
      }
      throw new S.StateError('NO_STATE', 'No run to stop.');
    }
    let state = null;
    try {
      state = S.read(this.p.state);
    } catch (err) {
      if (!force) throw err; // corrupted state must fail closed unless forced
    }
    const token = state ? state.lockToken : undefined;
    if (state) {
      state.state = S.STATES.STOPPED;
      state.updatedAt = nowIso(this.clock);
      state.lastAction = 'stop';
      S.write(this.p.state, state);
    } else {
      fs.rmSync(this.p.state, { force: true });
    }
    try {
      L.release(this.p.lock, token);
    } catch (err) {
      if (force) fs.rmSync(this.p.lock, { force: true });
      else {
        throw new S.StateError(
          'NOT_OWNER',
          'Lock is held by another runner; use --force only if you are sure it is dead.'
        );
      }
    }
    this.writeTombstone(force ? 'forced stop' : 'user stop');
    this.logEvent('stop', { runId: state ? state.runId : null, forced: force });
    return { state: S.STATES.STOPPED, runId: state ? state.runId : null };
  }

  writeTombstone(reason) {
    fs.mkdirSync(path.dirname(this.p.tombstone), { recursive: true });
    fs.writeFileSync(
      this.p.tombstone,
      JSON.stringify({ stoppedAt: nowIso(this.clock), reason }, null, 2),
      { mode: 0o600 }
    );
  }

  complete(evidence) {
    return this.mutate((s) => {
      if (S.TERMINAL.includes(s.state)) throw new S.StateError('TERMINAL', 'Run is already ' + s.state + '.');
      if (!evidence || !String(evidence).trim()) {
        throw new S.StateError(
          'NO_EVIDENCE',
          'Completion requires evidence that "' + s.contract.completionTest +
            '" passed. Unverified completion is a fake promise.'
        );
      }
      s.evidence.push({ ts: nowIso(this.clock), kind: 'completion', detail: String(evidence) });
      s.state = S.STATES.COMPLETED;
      return s;
    }, 'complete');
  }

  // Queue items may only come from the frozen objective or a user-approved
  // backlog. approvedByUser is the flag that lets an out-of-scope item in, and
  // it is recorded on the item so status shows where the work came from.
  enqueue(item, { approvedByUser = false } = {}) {
    return this.mutate((s) => {
      const text = String(item == null ? '' : item).trim();
      if (!text) throw new S.StateError('INVALID_ITEM', 'Queue item cannot be empty.');
      S.assertNoSecrets(text, 'queue item');
      if (s.queue.length >= 200) {
        throw new S.StateError('QUEUE_FULL', 'Follow-up queue cap (200) reached; this is a runaway guard.');
      }
      s.queue.push({ ts: nowIso(this.clock), item: text, approvedByUser: Boolean(approvedByUser) });
      return s;
    }, 'enqueue');
  }

  dequeue() {
    return this.mutate((s) => {
      s.queue.shift();
      return s;
    }, 'dequeue');
  }

  // A cycle is one inspect -> act -> verify pass. The counter is the hard
  // runaway cap; hitting it is terminal-ish (BLOCKED), never a silent reset.
  recordCycle() {
    return this.mutate((s) => {
      if (s.state !== S.STATES.AWAKE) throw new S.StateError('NOT_AWAKE', 'Cannot advance while ' + s.state + '.');
      s.cycles += 1;
      if (s.cycles >= s.contract.maxCycles) {
        s.state = S.STATES.BLOCKED;
        s.blocker = {
          ts: nowIso(this.clock),
          summary: 'safety cap reached (' + s.contract.maxCycles + ' cycles)',
          needsUser: true,
          capExceeded: true,
        };
      }
      return s;
    }, 'cycle');
  }

  // Records a blocker. Three consecutive identical blockers with no new route
  // stops advancing and asks the user for the smallest action that unblocks it.
  recordBlocker({ summary, smallestUserAction = null, newRoute = false }) {
    return this.mutate((s) => {
      const text = String(summary == null ? '' : summary).trim();
      if (!text) throw new S.StateError('INVALID_BLOCKER', 'Blocker summary is required.');
      S.assertNoSecrets(text, 'blocker');
      const same = s.blocker && s.blocker.summary === text && !newRoute;
      s.repeatedBlockerCount = same ? s.repeatedBlockerCount + 1 : 1;
      // Keep the last stated user action across repeats of the SAME blocker:
      // the caller that reports occurrence 3 should not have to restate it, and
      // an empty "needed from you" line is the least useful thing we could print.
      const carried = same && s.blocker ? s.blocker.smallestUserAction : null;
      s.blocker = {
        ts: nowIso(this.clock),
        summary: text,
        smallestUserAction: smallestUserAction ? String(smallestUserAction) : carried,
        needsUser: false,
        resolvedByUser: false,
      };
      if (s.repeatedBlockerCount >= BLOCKER_LIMIT) {
        s.state = S.STATES.BLOCKED;
        s.blocker.needsUser = true;
      }
      return s;
    }, 'blocker');
  }

  unblock(note = 'user cleared blocker') {
    return this.mutate((s) => {
      if (!s.blocker) throw new S.StateError('NO_BLOCKER', 'There is no blocker to clear.');
      if (s.blocker.capExceeded) {
        throw new S.StateError(
          'CAP_EXCEEDED',
          'The safety cap was exceeded. Clearing it is not a blocker fix: stop and start a fresh run.'
        );
      }
      s.blocker.resolvedByUser = true;
      s.blocker.note = String(note);
      s.repeatedBlockerCount = 0;
      s.state = S.STATES.AWAKE;
      return s;
    }, 'unblock');
  }

  // The whole continuation decision, in one auditable place. Returns
  // {continue: boolean, reason: string}. Every "false" path is a stopping rule
  // from the contract, never a guess.
  shouldContinue() {
    if (this.tombstone() && !S.exists(this.p.state)) {
      return { continue: false, reason: 'run was stopped; tombstone present' };
    }
    let state;
    try {
      state = S.read(this.p.state);
    } catch (err) {
      // Fail closed: unreadable state never continues.
      return { continue: false, reason: 'state unusable (' + err.code + '); refusing to continue' };
    }
    if (S.TERMINAL.includes(state.state)) return { continue: false, reason: 'run is ' + state.state };
    if (state.state === S.STATES.ASLEEP) return { continue: false, reason: 'asleep' };
    if (state.state === S.STATES.BLOCKED) {
      return { continue: false, reason: 'blocked: ' + (state.blocker ? state.blocker.summary : 'unknown') };
    }
    if (state.cycles >= state.contract.maxCycles) return { continue: false, reason: 'safety cap reached' };
    const owner = L.inspect(this.p.lock);
    if (!owner || owner.token !== state.lockToken) {
      return { continue: false, reason: 'workspace ownership lost; another runner may hold it' };
    }
    return {
      continue: true,
      reason: 'objective incomplete, authorized, and within cycle cap',
      nextAction: this.nextAction(state),
      completionTest: state.contract.completionTest,
      cyclesRemaining: state.contract.maxCycles - state.cycles,
    };
  }
}
