#Requires -Version 5.1
<#
  AI text provider chain for release.ps1 (release notes). Copied from AgentDesk. Dot-source it:

      . "$PSScriptRoot/ai-chat.ps1"

  Providers are tried in order; the first to return an answer the caller
  accepts wins. Each provider gets $AI_MAX_RETRIES attempts on transient
  errors, and is skipped immediately on a permanent one - bad key (401/403),
  withdrawn endpoint (404/410), missing key, or missing binary. Sleeping
  through a backoff schedule for an endpoint that is gone is exactly what made
  GitHub Models' retirement cost every release ~50 seconds and produce nothing.
#>

$AI_MAX_RETRIES = 2
$AI_BACKOFF_SEC = @(5, 15)   # wait seconds before retry 1, 2 (per provider)

$AI_PROVIDERS = @(
    @{ Name = "Claude CLI"; Kind = "cli" }
    @{ Name = "OpenAI";     Kind = "http"; Url = "https://api.openai.com/v1/chat/completions";     KeyVar = "OPENAI_API_KEY";     Model = "gpt-4o-mini" }
    @{ Name = "OpenRouter"; Kind = "http"; Url = "https://openrouter.ai/api/v1/chat/completions"; KeyVar = "OPENROUTER_API_KEY"; Model = "openai/gpt-4o-mini" }
)

function Get-AiExcerpt {
    param([string]$Text, [int]$Max = 80)
    $s = ($Text -replace "`r?`n", " ").Trim()
    if ($s.Length -le $Max) { return $s }
    return $s.Substring(0, $Max) + "..."
}

# Names of the providers this machine can actually reach, in try order.
# Callers check this BEFORE doing anything destructive, so a machine with
# nothing configured never gets half-way through a run that was doomed.
function Get-AiProviderNames {
    foreach ($p in $AI_PROVIDERS) {
        if ($p.Kind -eq "cli") {
            if (Get-Command claude -ErrorAction SilentlyContinue) { $p.Name }
        }
        elseif ([Environment]::GetEnvironmentVariable($p.KeyVar)) { $p.Name }
    }
}

function Write-AiProviderHelp {
    Write-Host "  Install Claude Code:  https://claude.com/claude-code   then run:  claude login"
    Write-Host "  Or set an API key:    `$env:OPENAI_API_KEY = 'sk-...'"
    Write-Host "                        `$env:OPENROUTER_API_KEY = 'sk-or-...'"
    Write-Host "  Permanently via:      [Environment]::SetEnvironmentVariable('OPENAI_API_KEY','sk-...','User')"
}

# --- Single-provider calls ---------------------------------------------------
# Each returns @{ Text = "<raw response>" } on success, or
# @{ Permanent = $bool; Reason = "<why>" } on failure. Permanent means retrying
# cannot help, so the caller skips straight to the next provider.

function Invoke-AiClaudeCli {
    param([string]$Prompt)

    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
        return @{ Permanent = $true; Reason = "claude binary not found on PATH" }
    }

    try {
        $raw = & claude -p $Prompt 2>&1 | Out-String
    }
    catch {
        return @{ Permanent = $false; Reason = $_.Exception.Message }
    }

    if ($LASTEXITCODE -ne 0) {
        return @{ Permanent = $false; Reason = "exit code $LASTEXITCODE - $(Get-AiExcerpt $raw)" }
    }
    return @{ Text = $raw }
}

function Invoke-AiChatCompletion {
    param($Provider, [string]$System, [string]$User, [int]$MaxTokens, [bool]$JsonMode)

    $key = [Environment]::GetEnvironmentVariable($Provider.KeyVar)
    if (-not $key) {
        return @{ Permanent = $true; Reason = "$($Provider.KeyVar) is not set" }
    }

    $messages = @()
    if ($System) { $messages += @{ role = "system"; content = $System } }
    $messages += @{ role = "user"; content = $User }

    $payload = @{
        model       = $Provider.Model
        messages    = $messages
        max_tokens  = $MaxTokens
        temperature = 0
    }
    if ($JsonMode) { $payload.response_format = @{ type = "json_object" } }
    $body = $payload | ConvertTo-Json -Depth 6

    try {
        $response = Invoke-RestMethod `
            -Uri         $Provider.Url `
            -Method      POST `
            -Headers     @{
                "Authorization" = "Bearer $key"
                "Content-Type"  = "application/json"
            } `
            -Body        $body `
            -TimeoutSec  60 `
            -ErrorAction Stop
    }
    catch {
        # Works for both PS5 WebException and PS7 HttpResponseException.
        $status = $null
        try { $status = $_.Exception.Response.StatusCode.value__ } catch {}

        # 404/410 belong here with the auth failures: an endpoint that has been
        # moved or withdrawn is exactly as permanent as a bad key.
        switch ($status) {
            401 { return @{ Permanent = $true; Reason = "$($Provider.KeyVar) is invalid or expired (401)" } }
            403 { return @{ Permanent = $true; Reason = "access denied (403) - key lacks access to $($Provider.Model)" } }
            404 { return @{ Permanent = $true; Reason = "endpoint gone (404) - check $($Provider.Url)" } }
            410 { return @{ Permanent = $true; Reason = "endpoint gone (410) - check $($Provider.Url)" } }
        }
        return @{ Permanent = $false; Reason = "HTTP $status - $($_.Exception.Message)" }
    }

    return @{ Text = $response.choices[0].message.content }
}

<#
  Run the provider chain until one returns something $Validate accepts.

  $Validate takes the raw response text and returns the parsed value, or $null
  if the response is unusable - a model that wrapped the answer in prose is a
  transient failure, so the same provider gets retried before moving on.

  Returns the validated value, or $null when every provider is exhausted.
#>
function Invoke-AiChat {
    param(
        [string]$System,
        [Parameter(Mandatory)][string]$User,
        [int]$MaxTokens = 400,
        [switch]$JsonMode,
        [Parameter(Mandatory)][scriptblock]$Validate
    )

    # The CLI has no system-message channel, so fold it into the prompt.
    $cliPrompt = if ($System) { "$System`n`n$User" } else { $User }

    foreach ($provider in $AI_PROVIDERS) {
        $attempt = 0
        while ($attempt -le $AI_MAX_RETRIES) {

            if ($attempt -gt 0) {
                $wait = $AI_BACKOFF_SEC[$attempt - 1]
                Write-Host "  $($provider.Name): attempt $attempt/$AI_MAX_RETRIES - retrying in ${wait}s..." -ForegroundColor Yellow
                Start-Sleep -Seconds $wait
            }

            Write-Host "  -> $($provider.Name)..." -ForegroundColor DarkGray

            $result = if ($provider.Kind -eq "cli") {
                Invoke-AiClaudeCli $cliPrompt
            } else {
                Invoke-AiChatCompletion $provider $System $User $MaxTokens ([bool]$JsonMode)
            }

            if ($result.Text) {
                $value = & $Validate $result.Text
                if ($null -ne $value) { return $value }
                $result = @{ Permanent = $false; Reason = "unexpected format: '$(Get-AiExcerpt $result.Text)'" }
            }

            if ($result.Permanent) {
                Write-Host "  $($provider.Name) unavailable: $($result.Reason)" -ForegroundColor Yellow
                break
            }

            Write-Host "  $($provider.Name) failed: $($result.Reason)" -ForegroundColor Yellow
            $attempt++
        }
    }

    return $null
}
