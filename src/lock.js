// One-writer ownership of a workspace.
//
// Uses an O_EXCL create as the mutex: on every platform Node supports, 'wx'
// either creates the file or fails with EEXIST. There is no check-then-create
// race. A lock records pid + workspace + a heartbeat time so a crashed owner
// can be reclaimed after a stale window, and reclaiming is logged, never silent.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_STALE_MS = 15 * 60 * 1000;

export class LockError extends Error {
  constructor(code, message, holder) {
    super(message);
    this.name = 'LockError';
    this.code = code;
    this.holder = holder;
  }
}

function readHolder(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);   // signal 0 = existence check, sends nothing
    return true;
  } catch (err) {
    return err.code === 'EPERM';   // exists but owned by another user
  }
}

export function acquire(file, { workspace, now = Date.now(), staleMs = DEFAULT_STALE_MS, pid = process.pid } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const holder = {
    token: crypto.randomUUID(),
    pid,
    workspace: path.resolve(workspace),
    acquiredAt: new Date(now).toISOString(),
    heartbeatAt: new Date(now).toISOString(),
  };
  const body = JSON.stringify(holder, null, 2);
  try {
    fs.writeFileSync(file, body, { flag: 'wx', mode: 0o600 });
    return holder;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  const current = readHolder(file);
  if (!current) {
    // Unreadable lock: treat as held. Failing closed beats stealing a workspace.
    throw new LockError('LOCK_UNREADABLE', 'A lock file exists but cannot be parsed. Refusing to take ownership. Inspect it manually.', null);
  }
  const age = now - Date.parse(current.heartbeatAt || current.acquiredAt || 0);
  const alive = pidAlive(current.pid);
  if (alive || !(age > staleMs)) {
    throw new LockError(
      'LOCKED',
      `Workspace is already owned by pid ${current.pid} since ${current.acquiredAt}. ` +
      'Two Persistent runners may not write the same workspace.',
      current
    );
  }
  // Stale and the owner is gone: reclaim, recording what we displaced.
  const reclaimed = { ...holder, reclaimedFrom: { pid: current.pid, heartbeatAt: current.heartbeatAt } };
  fs.writeFileSync(file, JSON.stringify(reclaimed, null, 2), { mode: 0o600 });
  return reclaimed;
}

export function heartbeat(file, token, now = Date.now()) {
  const current = readHolder(file);
  if (!current || current.token !== token) return false;
  current.heartbeatAt = new Date(now).toISOString();
  fs.writeFileSync(file, JSON.stringify(current, null, 2), { mode: 0o600 });
  return true;
}

export function release(file, token) {
  const current = readHolder(file);
  if (!current) return false;
  if (token && current.token !== token) {
    throw new LockError('NOT_OWNER', 'Refusing to release a lock held by another runner.', current);
  }
  fs.rmSync(file, { force: true });
  return true;
}

export function inspect(file) {
  return readHolder(file);
}
