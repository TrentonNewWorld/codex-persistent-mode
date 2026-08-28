#!/usr/bin/env node
// persist - lifecycle CLI for Codex Persistent mode.
//
// Every command is safe to run by hand and prints JSON with --json so a hook or
// a skill can consume it. Exit codes: 0 = ok, 1 = refused (with a reason),
// 2 = usage error. `should-continue` additionally exits 0 for continue and 3 for
// do-not-continue, so a shell hook can branch on the code alone.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Persistent } from '../src/lifecycle.js';
import { StateError } from '../src/state.js';
import { LockError } from '../src/lock.js';
import { install, uninstall, InstallError } from '../src/install.js';
import { paths } from '../src/paths.js';

const CLI = fileURLToPath(import.meta.url);

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out.flags[a.slice(2)] = argv[++i];
      else out.flags[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

function emit(json, value, human) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else console.log(human !== undefined ? human : JSON.stringify(value, null, 2));
}

const USAGE = `persist - Codex Persistent mode lifecycle

  persist install [--dry-run]        Additive, non-destructive merge into $CODEX_HOME
  persist uninstall [--keep-state]   Remove exactly what install added
  persist start --objective T --workspace DIR --completion-test T [--scope S]
                [--source URL] [--max-cycles N] [--force]
  persist status [--json]            Objective, queue, evidence, blocker, next action, awake?
  persist sleep [--reason T]         Stop continuation, keep state
  persist wake                       Resume the same contract
  persist stop [--force]             Terminate permanently (writes a tombstone)
  persist should-continue [--json]   Hook entry point. exit 0 continue / 3 do not
  persist cycle                      Record one completed inspect-act-verify cycle
  persist enqueue ITEM [--approved]  Add a follow-up item
  persist blocker --summary T [--action T] [--new-route]
  persist unblock [--note T]         Explicit user clearance of a blocker
  persist complete --evidence T      Verified completion; releases the loop
  persist where                      Print resolved paths

Global: --json for machine output. CODEX_HOME selects the install root, so an
isolated CODEX_HOME gives a fully isolated run.`;

async function main() {
  const { _: pos, flags } = parseArgs(process.argv.slice(2));
  const cmd = pos[0];
  const json = Boolean(flags.json);
  const pm = new Persistent();

  if (!cmd || cmd === 'help' || flags.help) {
    console.log(USAGE);
    return 0;
  }

  switch (cmd) {
    case 'where':
      emit(true, paths());
      return 0;

    case 'install': {
      const report = install({ cliPath: CLI, dryRun: Boolean(flags['dry-run']) });
      emit(json, report, (report.dryRun ? 'DRY RUN - nothing written\n' : 'Installed\n') +
        '  hooks.json : ' + report.hooks.action + ' (' + report.hooks.file + ')\n' +
        '  config.toml: ' + report.config.action + ' (' + report.config.file + ')' +
        (report.backups.length ? '\n  backups    : ' + report.backups.join(', ') : ''));
      return 0;
    }

    case 'uninstall': {
      const report = uninstall({ keepState: Boolean(flags['keep-state']) });
      emit(json, report, 'Uninstalled\n  hooks.json : ' + report.hooks + '\n  config.toml: ' + report.config + '\n  state      : ' + report.state);
      return 0;
    }

    case 'start': {
      const state = pm.start({
        objective: flags.objective,
        workspace: flags.workspace || process.cwd(),
        completionTest: flags['completion-test'],
        scope: flags.scope ? [].concat(flags.scope) : [],
        sources: flags.source ? [].concat(flags.source) : [],
        maxCycles: flags['max-cycles'] ? Number(flags['max-cycles']) : 25,
        force: Boolean(flags.force),
      });
      emit(json, { runId: state.runId, state: state.state, contract: state.contract },
        'Persistent mode ACTIVE\n  run       : ' + state.runId + '\n  objective : ' + state.contract.objective +
        '\n  workspace : ' + state.contract.workspace + '\n  done when : ' + state.contract.completionTest +
        '\n  cap       : ' + state.contract.maxCycles + ' cycles');
      return 0;
    }

    case 'status': {
      const s = pm.status();
      if (json) {
        console.log(JSON.stringify(s, null, 2));
        return 0;
      }
      if (!s.active && !s.runId) {
        console.log(s.message);
        return 0;
      }
      console.log(
        'run        : ' + s.runId + '\n' +
        'state      : ' + s.state + (s.awake ? ' (awake)' : ' (not advancing)') + '\n' +
        'objective  : ' + s.objective + '\n' +
        'workspace  : ' + s.workspace + '\n' +
        'done when  : ' + s.completionTest + '\n' +
        'cycles     : ' + s.cycles + '/' + s.maxCycles + '\n' +
        'queue      : ' + (s.queue.length ? s.queue.map((q) => '\n  - ' + q.item + (q.approvedByUser ? ' [user-approved]' : '')).join('') : '(empty)') + '\n' +
        'evidence   : ' + (s.evidence.length ? s.evidence.map((e) => '\n  - ' + e.detail).join('') : '(none)') + '\n' +
        'blocker    : ' + (s.blocker ? s.blocker.summary + ' (x' + s.repeatedBlockerCount + (s.blocker.needsUser ? ', NEEDS USER' : '') + ')' : '(none)') + '\n' +
        'next action: ' + s.nextAction
      );
      return 0;
    }

    case 'sleep': {
      const s = pm.sleep(flags.reason || 'user requested');
      emit(json, { state: s.state }, 'Asleep. State preserved; wake resumes the same contract.');
      return 0;
    }

    case 'wake': {
      const s = pm.wake();
      emit(json, { state: s.state, objective: s.contract.objective }, 'Awake on: ' + s.contract.objective);
      return 0;
    }

    case 'stop': {
      const r = pm.stop({ force: Boolean(flags.force) });
      emit(json, r, 'Stopped permanently. Heartbeats will not revive this run.');
      return 0;
    }

    case 'cycle': {
      const s = pm.recordCycle();
      emit(json, { cycles: s.cycles, state: s.state }, 'cycle ' + s.cycles + '/' + s.contract.maxCycles + ' - ' + s.state);
      return 0;
    }

    case 'enqueue': {
      const s = pm.enqueue(pos.slice(1).join(' ') || flags.item, { approvedByUser: Boolean(flags.approved) });
      emit(json, { queue: s.queue }, 'queued (' + s.queue.length + ' item(s))');
      return 0;
    }

    case 'blocker': {
      const s = pm.recordBlocker({
        summary: flags.summary,
        smallestUserAction: flags.action || null,
        newRoute: Boolean(flags['new-route']),
      });
      emit(json, { state: s.state, repeated: s.repeatedBlockerCount, blocker: s.blocker },
        'blocker recorded (x' + s.repeatedBlockerCount + ')' +
        (s.state === 'blocked' ? '\nSame blocker ' + s.repeatedBlockerCount + ' cycles running: advancing stopped, user action needed:\n  ' + (s.blocker.smallestUserAction || '(none stated)') : ''));
      return 0;
    }

    case 'unblock': {
      const s = pm.unblock(flags.note || 'user cleared blocker');
      emit(json, { state: s.state }, 'Blocker cleared by user; awake.');
      return 0;
    }

    case 'complete': {
      const s = pm.complete(flags.evidence);
      emit(json, { state: s.state }, 'Completion verified and recorded. The loop is released.');
      return 0;
    }

    case 'should-continue': {
      const verdict = pm.shouldContinue();
      emit(json, verdict, (verdict.continue ? 'CONTINUE' : 'DO NOT CONTINUE') + ' - ' + verdict.reason);
      return verdict.continue ? 0 : 3;
    }

    default:
      console.error('Unknown command: ' + cmd + '\n\n' + USAGE);
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof StateError || err instanceof LockError || err instanceof InstallError) {
      // Refusals are first-class output, not stack traces: the whole point is
      // that the user can see exactly which rule stopped it.
      console.error('[' + err.code + '] ' + err.message);
      process.exit(1);
    }
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
