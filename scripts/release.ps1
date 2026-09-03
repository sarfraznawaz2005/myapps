param(
    [string]$Version
)

$ErrorActionPreference = "Stop"
Set-Location -Path (Join-Path $PSScriptRoot "..")

function Fail($msg) {
    Write-Host ""
    Write-Host "RELEASE STOPPED: $msg" -ForegroundColor Red
    Write-Host "No tag was created. No release was made." -ForegroundColor Red
    exit 1
}

function Run($cmd, $cmdArgs, $step) {
    Write-Host "-> $step"
    & $cmd @cmdArgs
    if ($LASTEXITCODE -ne 0) {
        Fail "$step failed (exit code $LASTEXITCODE)."
    }
}

# 1. Repo must be clean
$status = git status --porcelain
if ($status) {
    Fail "You have uncommitted changes. Commit or stash them first."
}

# 2. Must be on a branch that has an upstream, and up to date with it
$branch = git rev-parse --abbrev-ref HEAD
if ($LASTEXITCODE -ne 0) { Fail "Could not read current git branch." }

git fetch origin
if ($LASTEXITCODE -ne 0) { Fail "git fetch failed. Check your network/remote." }

$local = git rev-parse HEAD
$upstream = git rev-parse "origin/$branch" 2>$null
if ($LASTEXITCODE -eq 0 -and $local -ne $upstream) {
    Fail "Local branch '$branch' is not in sync with origin/$branch. Pull or push first."
}

# 3. Work out the version
$pkgPath = "package.json"
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$currentVersion = $pkg.version

if (-not $Version) {
    $parts = $currentVersion.Split(".")
    $parts[2] = [int]$parts[2] + 1
    $Version = $parts -join "."
    Write-Host "No version given. Auto-bumping patch: $currentVersion -> $Version"
}

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    Fail "Version '$Version' is not in X.Y.Z format."
}

$tag = "v$Version"

$existingTag = git tag --list $tag
if ($existingTag) {
    Fail "Tag $tag already exists."
}

# 4. Install deps if needed
if (-not (Test-Path "node_modules")) {
    Run "npm" @("install") "Install dependencies"
}

# 5. Build locally first, as a pre-flight check. If this fails, nothing else happens.
Run "node" @("scripts/make-icons.js") "Generate icons"

$nsisCache = Join-Path $env:LOCALAPPDATA "electron-builder\Cache\nsis"
$buildAttempt = 1
while ($true) {
    Write-Host "-> Build app (pre-flight check)"
    $ErrorActionPreference = "Continue"
    $lines = & npm run dist 2>&1 | Tee-Object -Variable lines
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = "Stop"
    if ($exitCode -eq 0) { break }

    $text = $lines -join "`n"
    $isBrokenNsisCache = $text -match 'elevate\.exe' -or $text -match 'nsis-\d+.*ENOENT'
    if ($buildAttempt -eq 1 -and $isBrokenNsisCache -and (Test-Path $nsisCache)) {
        Write-Host "Detected a broken nsis download cache. Deleting it and retrying..." -ForegroundColor Yellow
        Remove-Item -Recurse -Force $nsisCache
        $buildAttempt++
        continue
    }
    Fail "Build app (pre-flight check) failed (exit code $exitCode)."
}

Write-Host "Build succeeded." -ForegroundColor Green

# 6. Bump version in package.json (writes package.json + package-lock.json)
Run "npm" @("version", $Version, "--no-git-tag-version", "--allow-same-version") "Set version to $Version"

# 7. Commit the version bump
git add package.json package-lock.json
git commit -m "chore: release $tag"
if ($LASTEXITCODE -ne 0) { Fail "git commit failed." }

# 8. Create the tag
git tag -a $tag -m "Release $tag"
if ($LASTEXITCODE -ne 0) { Fail "git tag failed." }

# 9. Push branch + tag. If this fails, undo the local commit and tag so nothing is left dangling.
git push origin $branch
if ($LASTEXITCODE -ne 0) {
    git tag -d $tag | Out-Null
    git reset --soft HEAD~1 | Out-Null
    Fail "git push of branch '$branch' failed. Local commit and tag were rolled back."
}

git push origin $tag
if ($LASTEXITCODE -ne 0) {
    git tag -d $tag | Out-Null
    Fail "git push of tag '$tag' failed (branch was already pushed). Local tag was rolled back — push it manually once fixed: git push origin $tag"
}

Write-Host ""
Write-Host "Done. Tag $tag pushed." -ForegroundColor Green
Write-Host "GitHub Actions will now build the Setup + zip and publish the Release." -ForegroundColor Green
