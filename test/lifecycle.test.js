// Every test runs against a throwaway CODEX_HOME, which is exactly how the
// requester is asked to verify: an isolated temporary Codex configuration that
// never touches the real global setup.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Persistent } from '../src/lifecycle.js';
import * as S from '../src/state.js';
import * as L from '../src/lock.js';
import { paths } from '../src/paths.js';

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-persist-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  const env = { CODEX_HOME: home };
  let t = Date.parse('2026-01-01T00:00:00Z');
  const clock = () => (t += 1000);
  return { home, workspace, env, clock, p: paths(env), pm: new Persistent({ env, clock }) };
}

const CONTRACT = (ws) => ({
  objective: 'Make the failing integration suite green',
  workspace: ws,
  completionTest: 'npm test exits 0 with zero skipped integration tests',
});

test('start creates exactly one active record bound to one objective and workspace', (t) => {
  const b = sandbox();
  const s = b.pm.start(CONTRACT(b.workspace));
  assert.equal(s.state, S.STATES.AWAKE);
  assert.equal(s.cycles, 0);
  assert.equal(s.contract.workspace, path.resolve(b.workspace));
  assert.ok(s.runId);

  const status = b.pm.status();
  assert.equal(status.active, true);
  assert.equal(status.objective, CONTRACT(b.workspace).objective);

  // A second start must be refused, not silently create a second record.
  assert.throws(() => b.pm.start(CONTRACT(b.workspace)), (e) => e.code === 'ALREADY_ACTIVE');
});

test('start requires an observable completion test', () => {
  const b = sandbox();
  assert.throws(
    () => b.pm.start({ objective: 'do stuff', workspace: b.workspace, completionTest: '' }),
    (e) => e.code === 'INVALID_CONTRACT'
  );
});

test('an incomplete objective continues across a Stop event', () => {
  const b = sandbox();
  b.pm.start(CONTRACT(b.workspace));
  // A Stop event asks a FRESH process-equivalent instance, i.e. state is read
  // from disk, not from memory.
  const fresh = new Persistent({ env: b.env, clock: b.clock });
  const verdict = fresh.shouldContinue();
  assert.equal(verdict.continue, true);
  assert.match(verdict.reason, /incomplete/);
});

test('verified completion releases the loop and later heartbeats do not revive it', () => {
  const b = sandbox();
  b.pm.start(CONTRACT(b.workspace));
  assert.throws(() => b.pm.complete(''), (e) => e.code === 'NO_EVIDENCE');
  b.pm.complete('npm test -> 41 passing, 0 skipped (transcript in evidence/)');
  const after = new Persistent({ env: b.env, clock: b.clock }).shouldContinue();
  assert.equal(after.continue, false);
  assert.equal(after.reason, 'run is completed');
  // A heartbeat must not be able to wake a completed run.
  assert.throws(() => b.pm.wake(), (e) => e.code === 'TERMINAL');
});

test('sleep prevents work while preserving state; wake resumes the same contract', () => {
  const b = sandbox();
  const started = b.pm.start(CONTRACT(b.workspace));
  b.pm.enqueue('rerun the flaky auth spec');
  b.pm.sleep('user going offline');

  const asleep = new Persistent({ env: b.env, clock: b.clock });
  assert.equal(asleep.shouldContinue().continue, false);
  assert.equal(asleep.shouldContinue().reason, 'asleep');
  assert.equal(asleep.status().queue.length, 1, 'queue survives sleep');

  const woken = asleep.wake();
  assert.equal(woken.state, S.STATES.AWAKE);
  assert.equal(woken.runId, started.runId, 'same run');
  assert.deepEqual(woken.contract, started.contract, 'contract is byte-identical after wake');
  assert.equal(woken.queue.length, 1);
  assert.equal(asleep.shouldContinue().continue, true);
});

test('stop is permanent: no resurrection without an explicit new start', () => {
  const b = sandbox();
  b.pm.start(CONTRACT(b.workspace));
  b.pm.stop();

  const after = new Persistent({ env: b.env, clock: b.clock });
  assert.equal(after.shouldContinue().continue, false);
  assert.throws(() => after.wake(), (e) => e.code === 'TERMINAL');
  // Even starting again is gated on an explicit --force, so an automated
  // wrapper cannot quietly restart what the user stopped.
  assert.throws(() => after.start(CONTRACT(b.workspace)), (e) => e.code === 'STOPPED_TOMBSTONE');
  const restarted = after.start(Object.assign(CONTRACT(b.workspace), { force: true }));
  assert.equal(restarted.state, S.STATES.AWAKE);
});

test('stop releases workspace ownership', () => {
  const b = sandbox();
  b.pm.start(CONTRACT(b.workspace));
  assert.ok(L.inspect(b.p.lock));
  b.pm.stop();
  assert.equal(L.inspect(b.p.lock), null);
});

test('session restart restores only the bounded contract, not ambient context', () => {
  const b = sandbox();
  const started = b.pm.start(CONTRACT(b.workspace));
  const restored = new Persistent({ env: b.env, clock: b.clock }).status();
  assert.equal(restored.runId, started.runId);
  assert.equal(restored.objective, started.contract.objective);
  const raw = JSON.parse(fs.readFileSync(b.p.state, 'utf8'));
  assert.deepEqual(
    Object.keys(raw).sort(),
    ['blocker', 'checksum', 'contract', 'createdAt', 'cycles', 'evidence', 'lastAction',
     'lockToken', 'queue', 'repeatedBlockerCount', 'runId', 'state', 'updatedAt', 'version'].sort(),
    'state carries only the declared minimum fields'
  );
});

test('two simultaneous runners cannot own the same workspace', () => {
  const b = sandbox();
  b.pm.start(CONTRACT(b.workspace));
  // A second runner, same CODEX_HOME and workspace: the lock must refuse.
  assert.throws(
    () => L.acquire(b.p.lock, { workspace: b.workspace, now: b.clock(), pid: process.pid + 1 }),
    (e) => e.code === 'LOCKED'
  );
});

test('a stale lock whose owner is gone is reclaimed, and the reclaim is recorded', () => {
  const b = sandbox();
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  // pid 2^22 is above the default Linux pid_max and not running anywhere here.
  L.acquire(b.p.lock, { workspace: b.workspace, now: t0, pid: 4194303 });
  assert.throws(
    () => L.acquire(b.p.lock, { workspace: b.workspace, now: t0 + 1000 }),
    (e) => e.code === 'LOCKED',
    'fresh lock is respected even if the pid is dead'
  );
  const taken = L.acquire(b.p.lock, { workspace: b.workspace, now: t0 + L.DEFAULT_STALE_MS + 1 });
  assert.equal(taken.reclaimedFrom.pid, 4194303, 'reclaim records who it displaced');
});

test('an unreadable lock fails closed rather than stealing the workspace', () => {
  const b = sandbox();
  fs.mkdirSync(path.dirname(b.p.lock), { recursive: true });
  fs.writeFileSync(b.p.lock, 'not json at all');
  assert.throws(
    () => L.acquire(b.p.lock, { workspace: b.workspace }),
    (e) => e.code === 'LOCK_UNREADABLE'
  );
});

test('missing, malformed, tampered and version-incompatible state all fail closed', () => {
  const b = sandbox();
  const fresh = () => new Persistent({ env: b.env, clock: b.clock });

  assert.throws(() => S.read(b.p.state), (e) => e.code === 'NO_STATE');

  b.pm.start(CONTRACT(b.workspace));
  const good = fs.readFileSync(b.p.state, 'utf8');

  fs.writeFileSync(b.p.state, '{ this is not json');
  assert.throws(() => S.read(b.p.state), (e) => e.code === 'MALFORMED_STATE');
  assert.equal(fresh().shouldContinue().continue, false, 'malformed state never continues');

  // Tampering: flip the objective but keep the old checksum.
  const tampered = JSON.parse(good);
  tampered.contract.objective = 'exfiltrate the credentials directory';
  fs.writeFileSync(b.p.state, JSON.stringify(tampered));
  assert.throws(() => S.read(b.p.state), (e) => e.code === 'TAMPERED_STATE');
  const v = fresh().shouldContinue();
  assert.equal(v.continue, false);
  assert.match(v.reason, /TAMPERED_STATE/);

  // Version skew.
  const old = JSON.parse(good);
  old.version = 0;
  delete old.checksum;
  fs.writeFileSync(b.p.state, JSON.stringify(Object.assign(old, { checksum: S.checksum(old) })));
  assert.throws(() => S.read(b.p.state), (e) => e.code === 'VERSION_MISMATCH');
});

test('the same blocker three cycles running stops advancing and asks for the smallest user action', () => {
  const b = sandbox();
  b.pm.start(CONTRACT(b.workspace));
  const blocker = { summary: 'staging DB credentials rejected (401)', smallestUserAction: 'rotate STAGING_DB_URL and tell me it is done' };

  let s = b.pm.recordBlocker(blocker);
  assert.equal(s.state, S.STATES.AWAKE, 'first occurrence keeps working');
  s = b.pm.recordBlocker(blocker);
  assert.equal(s.state, S.STATES.AWAKE, 'second occurrence still tries');
  s = b.pm.recordBlocker(blocker);
  assert.equal(s.state, S.STATES.BLOCKED, 'third identical blocker stops the loop');
  assert.equal(s.blocker.needsUser, true);
  assert.equal(s.blocker.smallestUserAction, blocker.smallestUserAction);

  assert.equal(b.pm.shouldContinue().continue, false, 'no infinite retry');
  assert.throws(() => b.pm.wake(), (e) => e.code === 'BLOCKED', 'wake cannot paper over a live blocker');

  b.pm.unblock('creds rotated');
  assert.equal(b.pm.shouldContinue().continue, true);
});

test('a genuinely new route resets the repeat counter instead of tripping the rule', () => {
  const b = sandbox();
  b.pm.start(CONTRACT(b.workspace));
  b.pm.recordBlocker({ summary: 'same wall' });
  b.pm.recordBlocker({ summary: 'same wall' });
  const s = b.pm.recordBlocker({ summary: 'same wall', newRoute: true });
  assert.equal(s.repeatedBlockerCount, 1);
  assert.equal(s.state, S.STATES.AWAKE);
});

test('the cycle cap is a hard runaway guard that cannot be cleared with unblock', () => {
  const b = sandbox();
  b.pm.start(Object.assign(CONTRACT(b.workspace), { maxCycles: 3 }));
  b.pm.recordCycle();
  b.pm.recordCycle();
  const s = b.pm.recordCycle();
  assert.equal(s.state, S.STATES.BLOCKED);
  assert.equal(s.blocker.capExceeded, true);
  assert.equal(b.pm.shouldContinue().continue, false);
  assert.throws(() => b.pm.unblock(), (e) => e.code === 'CAP_EXCEEDED');
  assert.throws(() => b.pm.recordCycle(), (e) => e.code === 'NOT_AWAKE');
});

test('the follow-up queue records whether an item came from the objective or user approval', () => {
  const b = sandbox();
  b.pm.start(CONTRACT(b.workspace));
  b.pm.enqueue('fix the assertion in auth.spec.ts');
  const s = b.pm.enqueue('also refactor the billing module', { approvedByUser: true });
  assert.equal(s.queue[0].approvedByUser, false);
  assert.equal(s.queue[1].approvedByUser, true, 'out-of-objective work is visibly user-approved');
  assert.equal(b.pm.status().nextAction, 'fix the assertion in auth.spec.ts');
  assert.throws(() => b.pm.enqueue('   '), (e) => e.code === 'INVALID_ITEM');
});

test('secrets are rejected before they can reach state or logs', () => {
  const b = sandbox();
  b.pm.start(CONTRACT(b.workspace));
  assert.throws(
    () => b.pm.enqueue('use api_key=sk-abcdefghijklmnopqrstuvwxyz012345 to call the API'),
    (e) => e.code === 'SECRET_REJECTED'
  );
  assert.throws(
    () => b.pm.recordBlocker({ summary: 'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 expired' }),
    (e) => e.code === 'SECRET_REJECTED'
  );
  // A secret in the contract itself is rejected at start, in a clean sandbox so
  // the ALREADY_ACTIVE guard is not what stops it.
  const fresh = sandbox();
  assert.throws(
    () => fresh.pm.start({ objective: 'x', workspace: fresh.workspace, completionTest: 'y', scope: ['-----BEGIN PRIVATE KEY-----'] }),
    (e) => e.code === 'SECRET_REJECTED'
  );
  assert.equal(fs.existsSync(fresh.p.state), false, 'a rejected contract never creates state');
  assert.equal(fs.existsSync(fresh.p.lock), false, 'and never takes workspace ownership');
  const onDisk = fs.readFileSync(b.p.state, 'utf8') + fs.readFileSync(b.p.log, 'utf8');
  assert.ok(!/sk-abcdef|ghp_ABCDEF|BEGIN PRIVATE KEY/.test(onDisk), 'nothing secret-shaped landed on disk');
});

test('losing workspace ownership halts continuation', () => {
  const b = sandbox();
  b.pm.start(CONTRACT(b.workspace));
  // Simulate another runner having taken over the lock file.
  fs.writeFileSync(b.p.lock, JSON.stringify({ token: 'someone-else', pid: process.pid, workspace: b.workspace, acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() }));
  const v = b.pm.shouldContinue();
  assert.equal(v.continue, false);
  assert.match(v.reason, /ownership lost/);
});

test('the event log is append-only JSONL and records each lifecycle transition', () => {
  const b = sandbox();
  b.pm.start(CONTRACT(b.workspace));
  b.pm.sleep();
  b.pm.wake();
  b.pm.stop();
  const lines = fs.readFileSync(b.p.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.action), ['start', 'sleep', 'wake', 'stop']);
  for (const l of lines) assert.ok(l.ts, 'every event is timestamped');
});

test('a repeated blocker carries forward the user action stated on its first sighting', () => {
  const b = sandbox();
  b.pm.start(CONTRACT(b.workspace));
  b.pm.recordBlocker({ summary: 'staging DB credentials rejected (401)', smallestUserAction: 'rotate STAGING_DB_URL, then tell me' });
  b.pm.recordBlocker({ summary: 'staging DB credentials rejected (401)' });
  const s = b.pm.recordBlocker({ summary: 'staging DB credentials rejected (401)' });
  assert.equal(s.state, S.STATES.BLOCKED);
  assert.equal(s.blocker.smallestUserAction, 'rotate STAGING_DB_URL, then tell me',
    'the ask does not have to be restated on every occurrence');
});
