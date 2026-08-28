// Non-destructive installation into a CODEX_HOME.
//
// The rule the bounty cares about most: an existing hooks.json / config.toml is
// preserved byte-for-byte except for an explicitly reviewed additive merge. So:
//
//   * We never rewrite a file we cannot parse -> fail closed with the reason.
//   * We never replace an existing key/hook that is not ours -> fail closed.
//   * Before any write we copy the original into persistent/backups/ so
//     uninstall can restore the exact bytes.
//   * --dry-run prints the exact diff-of-intent and writes nothing.
//
// config.toml is edited as an APPENDED, clearly fenced block rather than being
// parsed and re-emitted. Round-tripping TOML through a parser destroys comments
// and ordering, which would violate "preserved byte-for-byte".
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './paths.js';

export const MARK_BEGIN = '# >>> codex-persistent-mode (managed block) >>>';
export const MARK_END = '# <<< codex-persistent-mode (managed block) <<<';
export const HOOK_ID = 'codex-persistent-mode';

export class InstallError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InstallError';
    this.code = code;
  }
}

function backup(file, backupDir) {
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(backupDir, { recursive: true });
  const dest = path.join(backupDir, path.basename(file) + '.orig');
  if (!fs.existsSync(dest)) fs.copyFileSync(file, dest); // first install wins; never clobber a real baseline
  return dest;
}

// The hook entry we add. It calls our CLI and does nothing else. Note there is
// no --dangerously-bypass-approvals-and-sandbox, no --yolo, no exec of codex
// itself: the hook only ASKS whether continuing is authorized.
export function hookEntry(cliPath) {
  return {
    id: HOOK_ID,
    event: 'Stop',
    description: 'Ask Persistent mode whether the activated objective authorizes another cycle.',
    command: [process.execPath, cliPath, 'should-continue', '--json'],
    timeoutMs: 10000,
  };
}

export function planHooks(existingRaw, cliPath) {
  if (existingRaw == null) {
    return { action: 'create', next: JSON.stringify({ hooks: [hookEntry(cliPath)] }, null, 2) + '\n' };
  }
  let parsed;
  try {
    parsed = JSON.parse(existingRaw);
  } catch (err) {
    throw new InstallError(
      'HOOKS_UNPARSEABLE',
      'hooks.json exists but is not valid JSON (' + err.message + '). Refusing to touch it. ' +
        'Fix or move the file, then re-run install.'
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InstallError('HOOKS_SHAPE', 'hooks.json is not an object. Refusing to merge into an unknown shape.');
  }
  const list = parsed.hooks;
  if (list !== undefined && !Array.isArray(list)) {
    throw new InstallError('HOOKS_SHAPE', 'hooks.json has a "hooks" key that is not an array. Refusing to merge.');
  }
  const hooks = Array.isArray(list) ? list.slice() : [];
  const idx = hooks.findIndex((h) => h && h.id === HOOK_ID);
  if (idx === -1) {
    hooks.push(hookEntry(cliPath));
    return { action: 'append', next: JSON.stringify(Object.assign({}, parsed, { hooks }), null, 2) + '\n' };
  }
  hooks[idx] = hookEntry(cliPath); // only ever replaces OUR own entry
  return { action: 'update-own-entry', next: JSON.stringify(Object.assign({}, parsed, { hooks }), null, 2) + '\n' };
}

export function planConfig(existingRaw) {
  const block = [
    MARK_BEGIN,
    '# Added by codex-persistent-mode install. Remove with `persist uninstall`.',
    '# This block adds no permissions and changes no sandbox or approval setting.',
    '[persistent_mode]',
    'enabled = true',
    'state_dir = "persistent"',
    MARK_END,
  ].join('\n');

  if (existingRaw == null) return { action: 'create', next: block + '\n' };
  if (existingRaw.includes(MARK_BEGIN)) {
    if (!existingRaw.includes(MARK_END)) {
      throw new InstallError('CONFIG_BLOCK_BROKEN', 'config.toml has our begin marker without an end marker. Refusing to guess where the block ends.');
    }
    return { action: 'already-present', next: existingRaw };
  }
  if (/^\s*\[persistent_mode\]/m.test(existingRaw)) {
    throw new InstallError(
      'CONFIG_CONFLICT',
      'config.toml already defines a [persistent_mode] section that we did not write. ' +
        'Refusing to overwrite user configuration. Rename that section or remove it, then re-run.'
    );
  }
  const sep = existingRaw.endsWith('\n') ? '\n' : '\n\n';
  return { action: 'append', next: existingRaw + sep + block + '\n' };
}

function readOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export function install({ env = process.env, cliPath, dryRun = false } = {}) {
  const p = paths(env);
  const hooksRaw = readOrNull(p.hooksJson);
  const configRaw = readOrNull(p.configToml);

  // Plan everything BEFORE writing anything, so a conflict in the second file
  // cannot leave the first one half-modified.
  const hooksPlan = planHooks(hooksRaw, cliPath);
  const configPlan = planConfig(configRaw);

  const report = {
    codexHome: p.codexHome,
    dryRun,
    hooks: { file: p.hooksJson, action: hooksPlan.action },
    config: { file: p.configToml, action: configPlan.action },
    backups: [],
  };
  if (dryRun) return report;

  fs.mkdirSync(p.root, { recursive: true });
  const b1 = backup(p.hooksJson, p.backups);
  const b2 = backup(p.configToml, p.backups);
  if (b1) report.backups.push(b1);
  if (b2) report.backups.push(b2);

  fs.mkdirSync(path.dirname(p.hooksJson), { recursive: true });
  fs.writeFileSync(p.hooksJson, hooksPlan.next);
  if (configPlan.action !== 'already-present') fs.writeFileSync(p.configToml, configPlan.next);
  fs.writeFileSync(
    path.join(p.root, 'install.json'),
    JSON.stringify({ installedFrom: cliPath, hooks: hooksPlan.action, config: configPlan.action }, null, 2)
  );
  return report;
}

// Uninstall removes exactly what install added and nothing else. If a baseline
// backup exists and the current file differs only by our additions, we restore
// the baseline bytes; otherwise we surgically drop our entry/block so unrelated
// edits the user made since install are preserved.
export function uninstall({ env = process.env, keepState = false } = {}) {
  const p = paths(env);
  const report = { codexHome: p.codexHome, hooks: 'absent', config: 'absent', state: keepState ? 'kept' : 'removed' };

  const hooksRaw = readOrNull(p.hooksJson);
  if (hooksRaw != null) {
    let parsed = null;
    try {
      parsed = JSON.parse(hooksRaw);
    } catch {
      report.hooks = 'left-alone (unparseable)';
    }
    if (parsed && Array.isArray(parsed.hooks)) {
      const kept = parsed.hooks.filter((h) => !(h && h.id === HOOK_ID));
      if (kept.length === parsed.hooks.length) {
        report.hooks = 'no entry of ours';
      } else if (kept.length === 0 && Object.keys(parsed).length === 1) {
        const baseline = path.join(p.backups, 'hooks.json.orig');
        if (fs.existsSync(baseline)) {
          fs.copyFileSync(baseline, p.hooksJson);
          report.hooks = 'restored from baseline';
        } else {
          fs.rmSync(p.hooksJson, { force: true }); // we created it; nothing else was in it
          report.hooks = 'removed (we created it)';
        }
      } else {
        fs.writeFileSync(p.hooksJson, JSON.stringify(Object.assign({}, parsed, { hooks: kept }), null, 2) + '\n');
        report.hooks = 'entry removed, rest preserved';
      }
    }
  }

  const configRaw = readOrNull(p.configToml);
  if (configRaw != null) {
    // Exact-baseline path: if the file is still precisely what install would
    // have produced from the saved baseline, restore the baseline bytes. That
    // guarantees byte-for-byte restoration including the original trailing
    // newline, which surgical block-removal cannot promise on its own.
    const baselineFile = path.join(p.backups, 'config.toml.orig');
    if (fs.existsSync(baselineFile)) {
      const baseline = fs.readFileSync(baselineFile, 'utf8');
      let expected = null;
      try {
        expected = planConfig(baseline).next;
      } catch {
        expected = null;
      }
      if (expected != null && expected === configRaw) {
        fs.writeFileSync(p.configToml, baseline);
        report.config = 'restored from baseline (byte-identical)';
        if (!keepState) fs.rmSync(p.root, { recursive: true, force: true });
        return report;
      }
    }
    if (configRaw.includes(MARK_BEGIN) && configRaw.includes(MARK_END)) {
      const start = configRaw.indexOf(MARK_BEGIN);
      const end = configRaw.indexOf(MARK_END) + MARK_END.length;
      let next = configRaw.slice(0, start) + configRaw.slice(end);
      next = next.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
      if (next.trim() === '') {
        const baseline = path.join(p.backups, 'config.toml.orig');
        if (fs.existsSync(baseline)) {
          fs.copyFileSync(baseline, p.configToml);
          report.config = 'restored from baseline';
        } else {
          fs.rmSync(p.configToml, { force: true });
          report.config = 'removed (we created it)';
        }
      } else {
        fs.writeFileSync(p.configToml, next);
        report.config = 'block removed, rest preserved';
      }
    } else {
      report.config = 'no block of ours';
    }
  }

  if (!keepState) fs.rmSync(p.root, { recursive: true, force: true });
  return report;
}
