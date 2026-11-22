#!/usr/bin/env bash
# ============================================================================
# scripts/check-secrets.sh
# Fast, dependency-free local secret & personal-data scanner for public GitHub
# Also runs `gitleaks` automatically if installed on PATH.
# ============================================================================
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "🔍 Running Public-Repo Secret & Privacy Guardrail Checks..."
FAILURES=0

# ----------------------------------------------------------------------------
# Check 1: Verify forbidden credential files are NOT tracked or unignored
# ----------------------------------------------------------------------------
FORBIDDEN_FILES=(
  "firmware/settings.toml"
  "settings.toml"
  ".firebaserc"
  ".env"
  "functions/.env"
  "functions/.env.local"
)

for f in "${FORBIDDEN_FILES[@]}"; do
  if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    echo -e "${RED}[FAIL] Forbidden secret file is tracked by Git: $f${NC}"
    FAILURES=$((FAILURES + 1))
  fi
done

if [ "$FAILURES" -eq 0 ]; then
  echo -e "${GREEN}[PASS] Check 1: No forbidden config files (.firebaserc, settings.toml, .env) are tracked.${NC}"
fi

# ----------------------------------------------------------------------------
# Check 2: Scan all candidate files (tracked + untracked non-ignored) for secret patterns
# ----------------------------------------------------------------------------
CANDIDATE_FILES=()
while IFS= read -r file; do
  # Skip deleted files or the check script / gitleaks config itself
  [[ ! -f "$file" ]] && continue
  [[ "$file" == "scripts/check-secrets.sh" ]] && continue
  [[ "$file" == ".gitleaks.toml" ]] && continue
  CANDIDATE_FILES+=("$file")
done < <(git ls-files --cached --others --exclude-standard)

PATTERN_FAILURES=0

check_pattern() {
  local label="$1"
  local regex="$2"
  local file
  for file in "${CANDIDATE_FILES[@]}"; do
    if grep -nE "$regex" "$file" >/dev/null 2>&1; then
      echo -e "${RED}[FAIL] Potential $label detected in $file:${NC}"
      grep -nE "$regex" "$file" | sed 's/^/       /'
      PATTERN_FAILURES=$((PATTERN_FAILURES + 1))
      FAILURES=$((FAILURES + 1))
    fi
  done
}

# Scan for live credential patterns across all candidate files
check_pattern "Google/Firebase API Key (AIza...)" "AIza[0-9A-Za-z_-]{35}"
check_pattern "WorkOS Secret API Key (sk_live_/sk_test_)" "sk_(live|test)_[0-9a-zA-Z]{24,}"
check_pattern "WorkOS Client ID (client_01...)" "client_01[0-9A-HJ-NP-TV-Z]{24,}"
check_pattern "PEM Private Key" "-----BEGIN (RSA |EC |OPENSSH |PRIVATE )?KEY-----"

# Scan non-example code/config files for hardcoded Wi-Fi or device passwords
for file in "${CANDIDATE_FILES[@]}"; do
  [[ "$file" == *.example ]] && continue
  [[ "$file" == *.md ]] && continue
  if grep -nE '(CIRCUITPY_WIFI_PASSWORD|FIREBASE_DEVICE_PASSWORD|MCP_BEARER_FALLBACK_SECRET)[[:space:]]*=[[:space:]]*["'\''][^"'\'']+["'\'']' "$file" >/dev/null 2>&1; then
    echo -e "${RED}[FAIL] Hardcoded password/secret assignment in non-template file $file:${NC}"
    grep -nE '(CIRCUITPY_WIFI_PASSWORD|FIREBASE_DEVICE_PASSWORD|MCP_BEARER_FALLBACK_SECRET)[[:space:]]*=[[:space:]]*["'\''][^"'\'']+["'\'']' "$file" | sed 's/^/       /'
    PATTERN_FAILURES=$((PATTERN_FAILURES + 1))
    FAILURES=$((FAILURES + 1))
  fi
done

if [ "$PATTERN_FAILURES" -eq 0 ]; then
  echo -e "${GREEN}[PASS] Check 2: No API keys, private keys, or hardcoded passwords found across ${#CANDIDATE_FILES[@]} repo files.${NC}"
fi

# ----------------------------------------------------------------------------
# Check 3: Run Gitleaks CLI if installed (git history + non-ignored working tree)
# ----------------------------------------------------------------------------
if command -v gitleaks >/dev/null 2>&1; then
  TMP_SCAN_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_SCAN_DIR"' EXIT

  # Copy only git-tracked and untracked non-ignored files so gitignored local
  # secret files (firmware/settings.toml, functions/.env) don't cause false
  # positives, while still scanning every file eligible to be committed.
  while IFS= read -r file; do
    [[ ! -f "$file" ]] && continue
    mkdir -p "$TMP_SCAN_DIR/$(dirname "$file")"
    cp "$file" "$TMP_SCAN_DIR/$file"
  done < <(git ls-files --cached --others --exclude-standard)

  if gitleaks git --config="$REPO_ROOT/.gitleaks.toml" --no-banner --redact "$REPO_ROOT" >/dev/null 2>&1 && \
     gitleaks git --staged --config="$REPO_ROOT/.gitleaks.toml" --no-banner --redact "$REPO_ROOT" >/dev/null 2>&1 && \
     gitleaks dir --config="$REPO_ROOT/.gitleaks.toml" --no-banner --redact "$TMP_SCAN_DIR" >/dev/null 2>&1; then
    echo -e "${GREEN}[PASS] Check 3: Gitleaks CLI scan passed (git history + staged + non-ignored working tree).${NC}"
  else
    echo -e "${RED}[FAIL] Check 3: Gitleaks CLI detected potential secrets.${NC}"
    gitleaks git --config="$REPO_ROOT/.gitleaks.toml" --no-banner --redact "$REPO_ROOT" || true
    gitleaks git --staged --config="$REPO_ROOT/.gitleaks.toml" --no-banner --redact "$REPO_ROOT" || true
    gitleaks dir --config="$REPO_ROOT/.gitleaks.toml" --no-banner --redact "$TMP_SCAN_DIR" || true
    FAILURES=$((FAILURES + 1))
  fi
else
  echo -e "${YELLOW}[INFO] Check 3: Gitleaks CLI not installed locally (install via 'brew install gitleaks' for local Check 3, or rely on GitHub Actions CI).${NC}"
fi

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------
if [ "$FAILURES" -gt 0 ]; then
  echo ""
  echo -e "${RED}❌ Secret check FAILED with $FAILURES issue(s). Do NOT commit until resolved.${NC}"
  exit 1
else
  echo ""
  echo -e "${GREEN}✅ All secret and privacy guardrail checks passed! Safe to commit.${NC}"
  exit 0
fi
