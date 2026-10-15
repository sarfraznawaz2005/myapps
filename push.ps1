#Requires -Version 5.1
<#
  Pull, commit with an AI-written message, push. Nothing else.

  1. Pulls remote changes (rebase, with your uncommitted work set aside and put back).
  2. Stages everything (git add .; .gitignore is respected).
  3. Writes a commit message from the staged changes (scripts/ai-chat.ps1: local
     Claude CLI, then OPENAI_API_KEY, then OPENROUTER_API_KEY). If every provider
     fails, it stops WITHOUT committing; your files stay staged, so just run it again.
  4. Commits and pushes.
#>

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. "$ScriptDir/scripts/ai-chat.ps1"

$MAX_DIFF_CHARS = 8000   # long diffs are cut to stay within the token budget
$COMMIT_PATTERN = '^(feat|fix|docs|chore|refactor|test|perf|ci|build|style|revert)(\(.+\))?: .{3,97}$'

function Write-Section($t) { Write-Host ""; Write-Host "-> $t" -ForegroundColor Cyan }
function Write-Ok($t)      { Write-Host "  $t" -ForegroundColor Green }
function Write-Warn($t)    { Write-Host "  $t" -ForegroundColor Yellow }
function Write-Fail($t)    { Write-Host "  $t" -ForegroundColor Red }

# Models sometimes wrap the message in prose, so look at every line.
function Get-CommitLine {
    param([string]$Raw)
    if ([string]::IsNullOrWhiteSpace($Raw)) { return $null }
    $t = $Raw.Trim()
    if ($t -match $COMMIT_PATTERN) { return $t }
    return ($t -split "`n" |
        ForEach-Object { $_.Trim() } |
        Where-Object   { $_ -match $COMMIT_PATTERN } |
        Select-Object  -First 1)
}

# --- Repository checks ---
Write-Section "Checking repository..."
git rev-parse --git-dir 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Fail "Not inside a git repository."; exit 1 }

if (git status --porcelain | Select-String "^(UU|AA|DD)") {
    Write-Fail "Merge conflicts found. Fix them first."
    exit 1
}
git status -sb

# Checked before anything is staged, so a PC with no provider is not left half done.
$available = @(Get-AiProviderNames)
if (-not $available) {
    Write-Fail "No commit-message provider is available."
    Write-AiProviderHelp
    exit 1
}

$branch = git rev-parse --abbrev-ref HEAD
if ([string]::IsNullOrWhiteSpace($branch)) { Write-Fail "Cannot tell which branch this is."; exit 1 }

git rev-parse --abbrev-ref --symbolic-full-name "@{u}" 2>&1 | Out-Null
$hasUpstream = $LASTEXITCODE -eq 0

# --- Pull ---
if ($hasUpstream) {
    Write-Section "Pulling remote changes..."
    git pull --rebase --autostash
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "git pull failed. Fix the problem shown above, then run this again."
        exit 1
    }
}

# --- Stage ---
git add . 2>$null | Out-Null

# Never let a secrets file ride along by accident.
$risky = @(git diff --cached --name-only | Where-Object { $_ -match '(^|/)(\.env(\..*)?|[^/]*\.(pem|key|p12|pfx))$' })
if ($risky.Count -gt 0) {
    Write-Fail "These files look like secrets and are staged:"
    $risky | ForEach-Object { Write-Host "    $_" }
    Write-Host "  Unstage them (git restore --staged <file>) or add them to .gitignore, then run this again."
    exit 1
}

$stagedFiles = git diff --cached --name-only
if (-not $stagedFiles) {
    Write-Warn "Nothing new to commit."
}
else {
    # --- Commit message ---
    Write-Section "Writing the commit message ($($available -join ' -> '))..."

    $stats = git diff --cached --stat | Out-String
    $diff  = git diff --cached       | Out-String
    if ($diff.Length -gt $MAX_DIFF_CHARS) {
        $diff = $diff.Substring(0, $MAX_DIFF_CHARS) + "`n... (diff cut at $MAX_DIFF_CHARS chars)"
    }

    $promptText = @"
Analyze the staged git changes below and write a single conventional commit message.

Staged file stats:
$stats

Diff:
$diff

Rules:
- Format: type: description
- type must be one of: feat, fix, docs, chore, refactor, test, perf, ci, build, style, revert
- description: lowercase, present tense, no period at end, max 80 characters
- Return ONLY the single commit message line - no explanation, no quotes, no XML tags, no preamble.
"@

    $commitMsg = Invoke-AiChat -User $promptText -MaxTokens 80 -Validate { param($raw) Get-CommitLine $raw }

    if (-not $commitMsg) {
        Write-Fail "No provider could write a commit message."
        Write-Host "  Tried: $($available -join ', ')"
        Write-Host "  Your files are staged. Nothing is lost. Run this again when a provider works."
        exit 1
    }

    Write-Ok "Commit: $commitMsg"
    git commit -m $commitMsg
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "git commit failed. See the error above. Your changes are still staged."
        exit 1
    }
}

# --- Push ---
if ($hasUpstream) { $toPush = [int](git rev-list --count "@{u}..HEAD" 2>$null) }
else              { $toPush = [int](git rev-list --count HEAD 2>$null) }

if ($toPush -eq 0) {
    Write-Warn "Nothing to push."
    exit 0
}

Write-Section "Pushing $toPush commit(s) to origin/$branch..."
if ($hasUpstream) { git push } else { git push -u origin $branch }
if ($LASTEXITCODE -ne 0) { Write-Fail "git push failed."; exit 1 }

Write-Ok "Done."
exit 0
