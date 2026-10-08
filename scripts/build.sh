#!/usr/bin/env bash
# Rebuild the content of deployment/: install dependencies, compile, test and package the
# extension, then replace the .vsix in deployment/ with the fresh one.
#
# Run from the repository root:
#   ./scripts/build.sh               full rebuild (clean install, compile, tests, package)
#   ./scripts/build.sh --skip-tests  skip the unit tests
#   ./scripts/build.sh --no-clean    reuse extension/node_modules (faster, no `npm ci`)
#   ./scripts/build.sh --help
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT="$ROOT/extension"
DEPLOY="$ROOT/deployment"

TESTS=1
CLEAN=1
while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-tests) TESTS=0 ;;
        --no-clean)   CLEAN=0 ;;
        -h|--help)    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)            echo "error: unknown option: $1 (see --help)" >&2; exit 2 ;;
    esac
    shift
done

info() { echo "==> $*"; }
die()  { echo "error: $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "node is not installed (Node.js 22 or newer is required)"
command -v npm  >/dev/null 2>&1 || die "npm is not installed"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 22 ]] || die "Node.js 22 or newer is required (found $(node -v))"
[[ -f "$EXT/package.json" ]] || die "extension sources not found in $EXT"
[[ -f "$DEPLOY/install.sh" ]] || die "deployment/install.sh not found in $DEPLOY"

cd "$EXT"
NAME="$(node -p "require('./package.json').name")"
VERSION="$(node -p "require('./package.json').version")"
VSIX="$EXT/dist/$NAME-$VERSION.vsix"

if [[ $CLEAN -eq 1 ]]; then
    info "Installing dependencies (npm ci)"
    npm ci --no-audit --no-fund
else
    info "Reusing existing node_modules"
    [[ -d node_modules ]] || npm install --no-audit --no-fund
fi

info "Compiling"
rm -rf out
npm run --silent compile

if [[ $TESTS -eq 1 ]]; then
    info "Running tests"
    node --test "out/test/**/*.test.js"
fi

info "Packaging $NAME $VERSION"
mkdir -p dist
rm -f "$VSIX"
npx --no-install vsce package --out "$VSIX"

info "Updating deployment/"
rm -f "$DEPLOY"/*.vsix
cp "$VSIX" "$DEPLOY/"
chmod +x "$DEPLOY/install.sh"

echo
echo "Done: deployment/$(basename "$VSIX")"
echo "Install it with: ./deployment/install.sh"
