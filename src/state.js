// Durable state for one Persistent-mode run.
//
// Design rules enforced here:
//  - Exactly one active record. The file either holds one contract or nothing.
//  - Fail closed. Missing/malformed/tampered/version-mismatched state is never
//    "repaired" into a runnable state; it refuses to run and says why.
//  - Integrity is a keyed-free checksum over the canonical payload. It detects
//    accidental corruption and casual hand-editing. It is NOT an auth boundary:
//    anyone who can write the file can recompute it. That limitation is stated
//    in docs/LIMITATIONS.md rather than hidden behind crypto theatre.
//  - No secrets. `assertNoSecrets` rejects contracts carrying credential-shaped
//    values before they are ever written to disk.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const STATE_VERSION = 1;

export const STATES = Object.freeze({
  AWAKE: 'awake',
  ASLEEP: 'asleep',
  COMPLETED: 'completed',
  STOPPED: 'stopped',
  BLOCKED: 'blocked',
});

// Terminal states must never be revived by a heartbeat.
export const TERMINAL = Object.freeze([STATES.COMPLETED, STATES.STOPPED]);

export class StateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StateError';
    this.code = code;
  }
}

const SECRET_PATTERNS = [
  /-----BEGIN[ A-Z]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b0x[a-fA-F0-9]{64}\b/,           // raw 32-byte hex key / private key shape
  /\b[A-Za-z0-9_-]*(?:secret|passwd|password|api[_-]?key|token)[A-Za-z0-9_-]*\s*[:=]\s*\S+/i,
];

export function assertNoSecrets(value, where = 'state') {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) {
      throw new StateError(
        'SECRET_REJECTED',
        `Refusing to persist ${where}: it matches a credential pattern (${re}). ` +
        'Persistent mode never stores secrets. Pass a reference, not the value.'
      );
    }
  }
}

// Stable stringify so the checksum does not depend on key insertion order.
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

export function checksum(payload) {
  return crypto.createHash('sha256').update(canonical(payload)).digest('hex');
}

export function newContract({ objective, workspace, completionTest, scope = [], sources = [], maxCycles = 25, now }) {
  if (!objective || !String(objective).trim()) {
    throw new StateError('INVALID_CONTRACT', 'An objective is required.');
  }
  if (!workspace || !String(workspace).trim()) {
    throw new StateError('INVALID_CONTRACT', 'A workspace path is required (one-writer ownership is bound to it).');
  }
  if (!completionTest || !String(completionTest).trim()) {
    throw new StateError(
      'INVALID_CONTRACT',
      'A completion test is required. Without an observable stopping condition the loop cannot terminate honestly.'
    );
  }
  const capped = Number(maxCycles);
  if (!Number.isInteger(capped) || capped < 1 || capped > 500) {
    throw new StateError('INVALID_CONTRACT', 'maxCycles must be an integer between 1 and 500.');
  }
  const contract = {
    objective: String(objective).trim(),
    workspace: path.resolve(String(workspace)),
    completionTest: String(completionTest).trim(),
    scope: scope.map(String),
    permittedSources: sources.map(String),
    maxCycles: capped,
    frozenAt: now,
  };
  assertNoSecrets(contract, 'contract');
  return contract;
}

export function initialState(contract, now) {
  return {
    version: STATE_VERSION,
    runId: crypto.randomUUID(),
    state: STATES.AWAKE,
    contract,
    cycles: 0,
    queue: [],
    evidence: [],
    blocker: null,
    repeatedBlockerCount: 0,
    lastAction: 'start',
    createdAt: now,
    updatedAt: now,
  };
}

export function serialize(state) {
  const payload = { ...state };
  delete payload.checksum;
  return JSON.stringify({ ...payload, checksum: checksum(payload) }, null, 2);
}

export function write(file, state) {
  assertNoSecrets(state, 'state');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Atomic replace: a crash mid-write leaves the previous good state, never a
  // half-written file.
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, serialize(state), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return state;
}

// Reads and validates. Throws StateError with a precise code on every failure
// mode the acceptance tests exercise; never returns a partially trusted object.
export function read(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new StateError('NO_STATE', 'No Persistent mode run exists. Use `start` first.');
    throw new StateError('UNREADABLE_STATE', `Cannot read state file: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StateError('MALFORMED_STATE', 'State file is not valid JSON. Refusing to run. Inspect or `stop --force` to clear.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StateError('MALFORMED_STATE', 'State file is not a state object.');
  }
  if (parsed.version !== STATE_VERSION) {
    throw new StateError(
      'VERSION_MISMATCH',
      `State was written by schema version ${parsed.version}; this build speaks ${STATE_VERSION}. Refusing to guess. Run \`stop --force\` and start again.`
    );
  }
  const declared = parsed.checksum;
  const body = { ...parsed };
  delete body.checksum;
  if (typeof declared !== 'string' || declared !== checksum(body)) {
    throw new StateError('TAMPERED_STATE', 'State checksum does not match its contents. Refusing to run on untrusted state.');
  }
  for (const key of ['runId', 'state', 'contract', 'cycles']) {
    if (!(key in body)) throw new StateError('MALFORMED_STATE', `State is missing required field \`${key}\`.`);
  }
  if (!Object.values(STATES).includes(body.state)) {
    throw new StateError('MALFORMED_STATE', `Unknown lifecycle state \`${body.state}\`.`);
  }
  return body;
}

export function exists(file) {
  return fs.existsSync(file);
}
