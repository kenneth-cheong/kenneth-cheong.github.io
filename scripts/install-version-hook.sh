#!/bin/bash
# One-time setup: installs the pre-commit hook that auto-increments
# the app version (v1.0.N where N = total commit count + 1) displayed
# in the nav bar of index.html. Run from the repo root:
#
#   bash scripts/install-version-hook.sh
#
# The hook lives in .git/hooks/pre-commit which is not version-controlled,
# so each clone of the repo needs to install it once.

set -e
REPO_ROOT=$(git rev-parse --show-toplevel)
HOOK_PATH="$REPO_ROOT/.git/hooks/pre-commit"

cat > "$HOOK_PATH" << 'EOF'
#!/bin/bash
# Auto-increment app version in index.html before each commit.
# Version format: v1.0.N where N = total commit count + 1.

REPO_ROOT=$(git rev-parse --show-toplevel)
INDEX="$REPO_ROOT/index.html"

[ -f "$INDEX" ] || exit 0

COUNT=$(git rev-list --count HEAD 2>/dev/null || echo 0)
NEW_COUNT=$((COUNT + 1))
VERSION="v1.0.${NEW_COUNT}"

if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s|<span id=\"appVersion\">v[0-9.]*</span>|<span id=\"appVersion\">${VERSION}</span>|" "$INDEX"
else
    sed -i "s|<span id=\"appVersion\">v[0-9.]*</span>|<span id=\"appVersion\">${VERSION}</span>|" "$INDEX"
fi

git add "$INDEX"
echo "[pre-commit] Updated app version to ${VERSION}"
exit 0
EOF

chmod +x "$HOOK_PATH"
echo "✓ Installed pre-commit version hook at $HOOK_PATH"
