#!/usr/bin/env bash
# Reproducible end-to-end transcript against a throwaway CODEX_HOME.
# Nothing here touches the real ~/.codex. Run: bash test/e2e-transcript.sh
set -u
export CODEX_HOME="$(mktemp -d)"
WS="$(mktemp -d)"
P="node bin/persist.js"
run() { echo "\$ persist $*"; $P "$@"; echo "   -> exit $?"; echo; }

echo "CODEX_HOME=$CODEX_HOME (isolated)"; echo

# A pre-existing user config that must survive.
printf '# user comment\n[model]\nname = "gpt-5"\n' > "$CODEX_HOME/config.toml"
printf '{\n  "hooks": [\n    {\n      "id": "user-notify",\n      "event": "Stop",\n      "command": ["true"]\n    }\n  ]\n}\n' > "$CODEX_HOME/hooks.json"
BASE_CFG=$(sha256sum "$CODEX_HOME/config.toml" | cut -d' ' -f1)

run install --dry-run
run install
echo "--- user's config.toml after install (original bytes are a prefix) ---"; cat "$CODEX_HOME/config.toml"; echo
echo "--- hooks.json after install ---"; cat "$CODEX_HOME/hooks.json"; echo

run start --objective "Make the failing integration suite green" --workspace "$WS" --completion-test "npm test exits 0 with zero skipped integration tests" --max-cycles 4
run status
run should-continue
run enqueue "repair the flaky auth spec"
run cycle
run sleep --reason "user stepping away"
run should-continue
run wake
run blocker --summary "staging DB credentials rejected (401)" --action "rotate STAGING_DB_URL, then tell me"
run blocker --summary "staging DB credentials rejected (401)"
run blocker --summary "staging DB credentials rejected (401)"
run should-continue
run wake
run unblock --note "credentials rotated"
run complete --evidence "npm test -> 41 passing, 0 skipped"
run should-continue
run wake
run stop
run start --objective "second run" --workspace "$WS" --completion-test "x"

run uninstall
echo "--- config.toml after uninstall ---"; cat "$CODEX_HOME/config.toml"
AFTER_CFG=$(sha256sum "$CODEX_HOME/config.toml" | cut -d' ' -f1)
echo; echo "config.toml baseline sha: $BASE_CFG"
echo "config.toml after    sha: $AFTER_CFG"
[ "$BASE_CFG" = "$AFTER_CFG" ] && echo "BYTE-IDENTICAL: yes" || echo "BYTE-IDENTICAL: NO"
echo "--- hooks.json after uninstall ---"; cat "$CODEX_HOME/hooks.json"
rm -rf "$CODEX_HOME" "$WS"
