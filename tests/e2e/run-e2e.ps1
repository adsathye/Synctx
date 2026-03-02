# Synctx — E2E Test Runner (Windows)
#
# Usage:
#   .\tests\e2e\run-e2e.ps1
#
# Prerequisites: node, git, gh (authenticated), gitleaks
$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  Synctx — E2E Test Runner (Windows)"
Write-Host ""

# Check prerequisites
foreach ($cmd in @("node", "git", "gh", "gitleaks")) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Host "  [error] $cmd is required but not installed."
        exit 1
    }
}

# Check gh auth
try {
    $ghUser = gh api user --jq .login 2>$null
    Write-Host "  [ok] GitHub user: $ghUser"
} catch {
    Write-Host "  [error] gh not authenticated. Run: gh auth login"
    exit 1
}

# Set GH_TOKEN from gh auth
$env:GH_TOKEN = gh auth token 2>$null
if (-not $env:GH_TOKEN) {
    Write-Host "  [error] Could not get GH_TOKEN. Run: gh auth login"
    exit 1
}

# Run E2E tests
Write-Host "  [ok] Running E2E tests..."
Write-Host ""

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
node (Join-Path $PSScriptRoot "e2e-test.js")
$exitCode = $LASTEXITCODE

# Cleanup prompt
Write-Host ""
if ($exitCode -eq 0) {
    Write-Host "  [ok] All E2E tests passed!"
} else {
    Write-Host "  [!!] Some E2E tests failed."
}

Write-Host ""
Write-Host "  To cleanup test repos:"
Write-Host "    gh repo delete $ghUser/.synctx-e2e-test --yes"
Write-Host ""

exit $exitCode
