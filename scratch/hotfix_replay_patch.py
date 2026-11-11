"""2026-11-11 production hotfix for cloud BYOK fallback.

Problem: with ACCESS_AUTH_REQUIRED=1 the bootstrap skipped replaying the
persisted service config, leaving no global chat provider. Replacing the whole
compiled create-app-services.js from the local tree is unsafe (local src is
newer and imports modules not present on the server), so this script patches
exactly one condition in the production build artifact.

The same fix lives in server/src/bootstrap/create-app-services.ts for the next
proper release; do not keep patching by hand forever.
"""

from pathlib import Path

TARGET = Path("/opt/nextbot/server/dist/bootstrap/create-app-services.js")
ANCHOR = "if (!isAccessAuthRequired()) {"
REPLACEMENT = (
    "if (true) { // 2026-11-11 hotfix: replay persisted config as platform "
    "fallback; per-actor BYOK still wins"
)

text = TARGET.read_text(encoding="utf-8")
count = text.count(ANCHOR)
if count != 1:
    raise SystemExit(f"refuse to patch: anchor count={count} in {TARGET}")
TARGET.write_text(text.replace(ANCHOR, REPLACEMENT), encoding="utf-8")
print("PATCHED", TARGET)
