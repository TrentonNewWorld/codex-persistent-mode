// Resolves every path this tool touches. Everything lives under CODEX_HOME so an
// isolated CODEX_HOME gives you a fully isolated install (that is how the
// acceptance tests are meant to be run).
import path from 'node:path';
import os from 'node:os';

export function codexHome(env = process.env) {
  return env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export function paths(env = process.env) {
  const home = codexHome(env);
  const root = path.join(home, 'persistent');
  return {
    codexHome: home,
    root,
    state: path.join(root, 'state.json'),
    lock: path.join(root, 'owner.lock'),
    log: path.join(root, 'events.log'),
    tombstone: path.join(root, 'stopped.json'),
    hooksJson: path.join(home, 'hooks.json'),
    configToml: path.join(home, 'config.toml'),
    skillDir: path.join(home, 'skills', 'persistent-mode'),
    backups: path.join(root, 'backups'),
  };
}
