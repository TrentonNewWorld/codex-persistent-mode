// The install tests are the ones that protect the requester's machine: an
// existing config must survive byte-for-byte except for our reviewed addition.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { install, uninstall, planHooks, planConfig, HOOK_ID, MARK_BEGIN } from '../src/install.js';
import { paths } from '../src/paths.js';

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  return { dir, env: { CODEX_HOME: dir }, p: paths({ CODEX_HOME: dir }) };
}

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

test('fresh install creates hooks.json and config.toml with our entry only', () => {
  const h = home();
  const report = install({ env: h.env, cliPath: '/opt/persist/bin/persist.js' });
  assert.equal(report.hooks.action, 'create');
  assert.equal(report.config.action, 'create');

  const hooks = JSON.parse(fs.readFileSync(h.p.hooksJson, 'utf8'));
  assert.equal(hooks.hooks.length, 1);
  assert.equal(hooks.hooks[0].id, HOOK_ID);
  assert.equal(hooks.hooks[0].event, 'Stop');

  const toml = fs.readFileSync(h.p.configToml, 'utf8');
  assert.ok(toml.includes(MARK_BEGIN));
  assert.ok(toml.includes('[persistent_mode]'));
});

test('the installed hook never passes a sandbox or approval bypass', () => {
  const h = home();
  install({ env: h.env, cliPath: '/opt/persist/bin/persist.js' });
  const raw = fs.readFileSync(h.p.hooksJson, 'utf8') + fs.readFileSync(h.p.configToml, 'utf8');
  for (const banned of ['--dangerously-bypass-approvals-and-sandbox', '--yolo', 'bypass', 'full-auto', '--ask-for-approval never']) {
    assert.ok(!raw.includes(banned), 'must not contain ' + banned);
  }
});

test('an existing hooks.json keeps every unrelated hook and its own keys', () => {
  const h = home();
  fs.mkdirSync(h.dir, { recursive: true });
  const existing = {
    version: 2,
    hooks: [{ id: 'user-notify', event: 'Stop', command: ['say', 'done'] }],
    somethingElse: { keep: true },
  };
  fs.writeFileSync(h.p.hooksJson, JSON.stringify(existing, null, 2));

  const report = install({ env: h.env, cliPath: '/opt/persist/bin/persist.js' });
  assert.equal(report.hooks.action, 'append');

  const after = JSON.parse(fs.readFileSync(h.p.hooksJson, 'utf8'));
  assert.equal(after.version, 2, 'unrelated top-level keys preserved');
  assert.deepEqual(after.somethingElse, { keep: true });
  assert.equal(after.hooks.length, 2);
  assert.deepEqual(after.hooks[0], existing.hooks[0], 'the user hook is untouched');
  assert.equal(after.hooks[1].id, HOOK_ID);
});

test('an existing config.toml is preserved byte-for-byte with our block appended', () => {
  const h = home();
  fs.mkdirSync(h.dir, { recursive: true });
  const original = '# my careful comments\n[model]\nname = "gpt-5"   # inline comment\n\n[sandbox]\nmode = "workspace-write"\n';
  fs.writeFileSync(h.p.configToml, original);

  install({ env: h.env, cliPath: '/opt/persist/bin/persist.js' });
  const after = fs.readFileSync(h.p.configToml, 'utf8');
  assert.ok(after.startsWith(original), 'the original bytes are a literal prefix - comments and ordering intact');
  assert.ok(after.includes(MARK_BEGIN));
  assert.ok(after.includes('mode = "workspace-write"'), 'we did not touch the sandbox setting');
});

test('install is idempotent: running twice does not duplicate the hook or the block', () => {
  const h = home();
  install({ env: h.env, cliPath: '/opt/persist/bin/persist.js' });
  const firstConfig = fs.readFileSync(h.p.configToml, 'utf8');
  install({ env: h.env, cliPath: '/opt/persist/bin/persist.js' });

  const hooks = JSON.parse(fs.readFileSync(h.p.hooksJson, 'utf8'));
  assert.equal(hooks.hooks.filter((x) => x.id === HOOK_ID).length, 1);
  assert.equal(fs.readFileSync(h.p.configToml, 'utf8'), firstConfig, 'config unchanged on re-install');
});

test('install fails closed on an unparseable hooks.json and writes nothing', () => {
  const h = home();
  fs.mkdirSync(h.dir, { recursive: true });
  fs.writeFileSync(h.p.hooksJson, '{ not: valid json,,, }');
  const before = sha(h.p.hooksJson);

  assert.throws(() => install({ env: h.env, cliPath: '/x' }), (e) => e.code === 'HOOKS_UNPARSEABLE');
  assert.equal(sha(h.p.hooksJson), before, 'the file we could not understand is byte-identical');
  assert.equal(fs.existsSync(h.p.configToml), false, 'and the second file was never created');
});

test('install fails closed on a conflicting [persistent_mode] section it did not write', () => {
  const h = home();
  fs.mkdirSync(h.dir, { recursive: true });
  const original = '[persistent_mode]\nenabled = false\n';
  fs.writeFileSync(h.p.configToml, original);
  assert.throws(() => install({ env: h.env, cliPath: '/x' }), (e) => e.code === 'CONFIG_CONFLICT');
  assert.equal(fs.readFileSync(h.p.configToml, 'utf8'), original);
  assert.equal(fs.existsSync(h.p.hooksJson), false, 'planning happens before any write');
});

test('dry-run reports the plan and writes nothing at all', () => {
  const h = home();
  const report = install({ env: h.env, cliPath: '/x', dryRun: true });
  assert.equal(report.dryRun, true);
  assert.equal(report.hooks.action, 'create');
  assert.equal(fs.existsSync(h.p.hooksJson), false);
  assert.equal(fs.existsSync(h.p.configToml), false);
  assert.equal(fs.existsSync(h.p.root), false);
});

test('uninstall returns a pre-existing configuration to its exact baseline', () => {
  const h = home();
  fs.mkdirSync(h.dir, { recursive: true });
  const hooksOriginal = JSON.stringify({ hooks: [{ id: 'user-notify', event: 'Stop', command: ['say', 'hi'] }] }, null, 2);
  const configOriginal = '# keep me\n[model]\nname = "gpt-5"\n';
  fs.writeFileSync(h.p.hooksJson, hooksOriginal);
  fs.writeFileSync(h.p.configToml, configOriginal);
  const hooksSha = sha(h.p.hooksJson);
  const configSha = sha(h.p.configToml);

  install({ env: h.env, cliPath: '/x' });
  assert.notEqual(sha(h.p.hooksJson), hooksSha, 'install did change it');

  uninstall({ env: h.env });
  assert.equal(JSON.parse(fs.readFileSync(h.p.hooksJson, 'utf8')).hooks.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(h.p.hooksJson, 'utf8')).hooks[0].id, 'user-notify');
  assert.equal(sha(h.p.configToml), configSha, 'config.toml is byte-identical to the baseline');
  assert.equal(fs.existsSync(h.p.root), false, 'our state dir is gone');
});

test('uninstall preserves unrelated files and edits made after install', () => {
  const h = home();
  install({ env: h.env, cliPath: '/x' });
  const unrelated = path.join(h.dir, 'AGENTS.md');
  fs.writeFileSync(unrelated, '# my project instructions\n');
  // The user adds their own hook after we installed.
  const hooks = JSON.parse(fs.readFileSync(h.p.hooksJson, 'utf8'));
  hooks.hooks.push({ id: 'mine', event: 'Stop', command: ['true'] });
  fs.writeFileSync(h.p.hooksJson, JSON.stringify(hooks, null, 2));

  uninstall({ env: h.env });
  assert.equal(fs.readFileSync(unrelated, 'utf8'), '# my project instructions\n');
  const after = JSON.parse(fs.readFileSync(h.p.hooksJson, 'utf8'));
  assert.deepEqual(after.hooks.map((x) => x.id), ['mine'], 'our entry removed, theirs kept');
});

test('uninstall --keep-state leaves the run record for inspection', () => {
  const h = home();
  install({ env: h.env, cliPath: '/x' });
  uninstall({ env: h.env, keepState: true });
  assert.equal(fs.existsSync(h.p.root), true);
});

test('planHooks refuses a hooks.json whose shape it does not understand', () => {
  assert.throws(() => planHooks('[1,2,3]', '/x'), (e) => e.code === 'HOOKS_SHAPE');
  assert.throws(() => planHooks('{"hooks": "nope"}', '/x'), (e) => e.code === 'HOOKS_SHAPE');
});

test('planConfig refuses a half-written managed block rather than guessing', () => {
  assert.throws(() => planConfig(MARK_BEGIN + '\nenabled = true\n'), (e) => e.code === 'CONFIG_BLOCK_BROKEN');
});
