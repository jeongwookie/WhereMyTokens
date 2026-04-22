param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

$ErrorActionPreference = 'Continue'

# 공개 저장소에는 개인 패턴을 넣지 않고, 로컬 파일에서만 읽는다.
$PrivatePatternPath = Join-Path $HOME '.codex\private\wheremytokens-privacy-patterns.txt'
$GitleaksConfigPath = Join-Path $RepoRoot '.gitleaks.toml'
$GenericSecretPatterns = @(
  '-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----',
  '\bsk-[A-Za-z0-9_-]{20,}\b',
  '\bgh[pousr]_[A-Za-z0-9_]{20,}\b',
  '\bgithub_pat_[A-Za-z0-9_]{20,}\b',
  '\bxox[baprs]-[A-Za-z0-9-]{10,}\b',
  '\bAKIA[0-9A-Z]{16}\b',
  '\bAIza[0-9A-Za-z_-]{35}\b',
  '\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*["''][^"'']{12,}["'']'
)

function Write-Section {
  param([string]$Title)
  Write-Output ''
  Write-Output "== $Title =="
}

function Invoke-Gitleaks {
  param(
    [string]$Mode,
    [string[]]$Arguments,
    [string]$StdinText = $null
  )

  Write-Section "gitleaks $Mode"

  $output = if ($null -ne $StdinText) {
    $StdinText | & gitleaks $Mode --redact --no-banner --log-level error @Arguments 2>&1
  } else {
    & gitleaks $Mode --redact --no-banner --log-level error @Arguments 2>&1
  }

  $exitCode = $LASTEXITCODE
  if ($output) {
    $output | ForEach-Object { Write-Output $_ }
  } else {
    Write-Output 'No output.'
  }

  if ($exitCode -eq 0) {
    Write-Output "Result: no leaks detected by gitleaks $Mode."
  } elseif ($exitCode -eq 1) {
    Write-Output "Result: gitleaks $Mode reported findings."
  } else {
    Write-Output "Result: gitleaks $Mode exited with code $exitCode."
  }

  return
}

function Get-PrivatePatterns {
  if (-not (Test-Path -LiteralPath $PrivatePatternPath)) {
    return @()
  }

  Get-Content -LiteralPath $PrivatePatternPath -Encoding UTF8 |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -and -not $_.StartsWith('#') }
}

function Test-TextPatterns {
  param(
    [string]$Label,
    [string]$Text,
    [string[]]$PrivatePatterns
  )

  Write-Section "fallback $Label"

  $found = $false
  foreach ($pattern in $GenericSecretPatterns) {
    if ($Text -match $pattern) {
      Write-Output "Generic secret-like pattern matched: $pattern"
      $found = $true
    }
  }

  foreach ($pattern in $PrivatePatterns) {
    if ($Text.IndexOf($pattern, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      Write-Output 'Private local pattern matched. Value redacted.'
      $found = $true
    }
  }

  if (-not $found) {
    Write-Output 'No fallback findings.'
  }
}

function Get-TrackedText {
  param([string]$Root)

  $builder = [System.Text.StringBuilder]::new()
  $files = git -C $Root ls-files
  foreach ($file in $files) {
    $path = Join-Path $Root $file
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      continue
    }

    try {
      $content = Get-Content -LiteralPath $path -Raw -Encoding UTF8 -ErrorAction Stop
      [void]$builder.AppendLine("FILE: $file")
      [void]$builder.AppendLine($content)
    } catch {
      [void]$builder.AppendLine("SKIPPED_BINARY_OR_UNREADABLE: $file")
    }
  }

  $builder.ToString()
}

$repo = (Resolve-Path -LiteralPath $RepoRoot).Path
$gitleaksConfig = (Resolve-Path -LiteralPath $GitleaksConfigPath -ErrorAction SilentlyContinue).Path
Write-Output "Repo: $repo"
Write-Output "Private pattern file: $PrivatePatternPath"
if ($gitleaksConfig) {
  Write-Output "Gitleaks config: $gitleaksConfig"
} else {
  Write-Output 'Gitleaks config: default built-in config only.'
}

$privatePatterns = @(Get-PrivatePatterns)
if ($privatePatterns.Count -gt 0) {
  Write-Output "Private pattern file loaded: $($privatePatterns.Count) pattern(s)."
} else {
  Write-Output 'Private pattern file not found or empty.'
}

$configArgs = @()
if ($gitleaksConfig) {
  $configArgs = @('--config', $gitleaksConfig)
}

$gitleaksAvailable = [bool](Get-Command gitleaks -ErrorAction SilentlyContinue)

if ($gitleaksAvailable) {
  Invoke-Gitleaks -Mode 'git' -Arguments @($configArgs + @('--verbose', '--timeout', '120', $repo))
  Invoke-Gitleaks -Mode 'dir' -Arguments @($configArgs + @('--verbose', '--timeout', '120', $repo))
} else {
  Write-Section 'gitleaks git'
  Write-Output 'Gitleaks is not installed or not on PATH. Fallback scanner will run.'
  Write-Section 'gitleaks dir'
  Write-Output 'Gitleaks is not installed or not on PATH. Fallback scanner will run.'
}

$stagedDiff = git -C $repo diff --cached --unified=0
if ($stagedDiff) {
  if ($gitleaksAvailable) {
    Invoke-Gitleaks -Mode 'stdin' -Arguments $configArgs -StdinText $stagedDiff
  } else {
    Write-Section 'gitleaks stdin'
    Write-Output 'Gitleaks is not installed or not on PATH. Fallback scanner will run.'
  }
  Test-TextPatterns -Label 'staged diff' -Text $stagedDiff -PrivatePatterns $privatePatterns
} else {
  Write-Section 'gitleaks stdin'
  Write-Output 'No staged diff to scan.'
}

if (-not $gitleaksAvailable) {
  $trackedText = Get-TrackedText -Root $repo
  Test-TextPatterns -Label 'tracked files' -Text $trackedText -PrivatePatterns $privatePatterns
}
