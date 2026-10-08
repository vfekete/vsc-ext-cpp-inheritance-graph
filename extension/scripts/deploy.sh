#!/usr/bin/env bash
# Build, test, package and install the extension from the command line.
#
#   scripts/deploy.sh                 # build + test + package + install into `code`
#   scripts/deploy.sh --no-install    # only produce dist/cpp-inheritance-graph-<version>.vsix
#   scripts/deploy.sh --skip-tests
#   scripts/deploy.sh --code code-insiders   # or codium, cursor, ...
#   scripts/deploy.sh --copy          # install by copying into ~/.vscode/extensions (no vsce/CLI needed)
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

CODE_BIN="${CODE_BIN:-code}"
INSTALL=1
TESTS=1
COPY=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-install) INSTALL=0 ;;
        --skip-tests) TESTS=0 ;;
        --code) CODE_BIN="$2"; shift ;;
        --copy) COPY=1 ;;
        -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done

NAME=$(node -p "require('./package.json').name")
PUBLISHER=$(node -p "require('./package.json').publisher")
VERSION=$(node -p "require('./package.json').version")
VSIX="dist/${NAME}-${VERSION}.vsix"

echo "==> Installing dependencies"
if [[ -f package-lock.json ]]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi

echo "==> Compiling"
npm run compile

if [[ $TESTS -eq 1 ]]; then
    echo "==> Running tests"
    node --test "out/test/**/*.test.js"
fi

if [[ $COPY -eq 1 ]]; then
    DEST="${VSCODE_EXTENSIONS:-$HOME/.vscode/extensions}/${PUBLISHER}.${NAME}-${VERSION}"
    echo "==> Copying extension to $DEST"
    rm -rf "$DEST"
    mkdir -p "$DEST/out"
    cp -r package.json README.md LICENSE CHANGELOG.md media "$DEST/"
    cp -r out/src "$DEST/out/"
    echo "Done. Reload VS Code (Developer: Reload Window) to activate."
    exit 0
fi

echo "==> Packaging $VSIX"
mkdir -p dist
npx --no-install vsce package --out "$VSIX"
# Keep the standalone installer bundle (../deployment/) up to date.
rm -f ../deployment/*.vsix
cp "$VSIX" ../deployment/

if [[ $INSTALL -eq 1 ]]; then
    if ! command -v "$CODE_BIN" >/dev/null 2>&1; then
        echo "'$CODE_BIN' not found on PATH; install manually with: <code-cli> --install-extension $VSIX" >&2
        exit 1
    fi
    echo "==> Installing into $CODE_BIN"
    "$CODE_BIN" --install-extension "$VSIX" --force
    echo "Done. Reload VS Code windows (Developer: Reload Window) to pick up the new version."
else
    echo "Done: $VSIX"
fi
