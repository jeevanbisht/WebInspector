<#
.SYNOPSIS
  WebInspector agent onboarding (Windows, git-based).

.DESCRIPTION
  Self-contained onboarding that needs NO pre-published supervisor bundle: it clones the repo,
  pins the ControlPlane CA, enrolls the node, and runs the supervisor as a SYSTEM scheduled task
  (auto-start, auto-restart). This is the Windows path the Portal's Onboarding tab hands out.

  Prerequisites on the VM: Node.js 18+ and git on PATH
  (e.g. `winget install OpenJS.NodeJS.LTS Git.Git`).

.EXAMPLE
  # Unattended one-liner (Administrator PowerShell)
  $env:WEBINSPECTOR_CONTROLPLANE_URL='https://cp:8787'
  $env:WEBINSPECTOR_ENROLLMENT_TOKEN='<token>'
  $env:WEBINSPECTOR_NODE_TYPE='azure_direct'
  iwr -UseBasicParsing https://cp:8787/bootstrap/install-agent.ps1 | iex
#>
[CmdletBinding()]
param(
  [string]$ControlPlaneUrl = $env:WEBINSPECTOR_CONTROLPLANE_URL,
  [string]$EnrollmentToken = $env:WEBINSPECTOR_ENROLLMENT_TOKEN,
  [string]$NodeName        = $env:WEBINSPECTOR_NODE_NAME,
  [string]$NodeType        = $env:WEBINSPECTOR_NODE_TYPE,
  [string]$InstallRoot     = $(if ($env:WEBINSPECTOR_INSTALL_ROOT) { $env:WEBINSPECTOR_INSTALL_ROOT } else { 'C:\WebInspector' }),
  [string]$Repo            = $(if ($env:WEBINSPECTOR_REPO) { $env:WEBINSPECTOR_REPO } else { 'https://github.com/jeevanbisht/WebInspector.git' }),
  [string]$Branch          = $(if ($env:WEBINSPECTOR_BRANCH) { $env:WEBINSPECTOR_BRANCH } else { 'main' })
)
$ErrorActionPreference = 'Stop'
function Step($m) { Write-Host "[install-agent] $m" }

# 1. Require admin (needed to register a SYSTEM scheduled task).
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'install-agent.ps1 must run as Administrator.' }

# 2. Validate inputs.
if (-not $ControlPlaneUrl) { throw 'ControlPlaneUrl is required (-ControlPlaneUrl or WEBINSPECTOR_CONTROLPLANE_URL).' }
if (-not $EnrollmentToken) { throw 'EnrollmentToken is required (-EnrollmentToken or WEBINSPECTOR_ENROLLMENT_TOKEN).' }
if (-not $NodeType)        { throw 'NodeType is required (-NodeType or WEBINSPECTOR_NODE_TYPE).' }
if (-not $NodeName)        { $NodeName = $env:COMPUTERNAME }
$ControlPlaneUrl = $ControlPlaneUrl.TrimEnd('/')

# 3. Prerequisites.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 18+ not found. Install it first: winget install OpenJS.NodeJS.LTS' }
if (-not (Get-Command git  -ErrorAction SilentlyContinue)) { throw 'git not found. Install it first: winget install Git.Git' }

# 4. Fetch code.
$app = Join-Path $InstallRoot 'app'
New-Item -ItemType Directory -Force -Path (Join-Path $InstallRoot 'tls') | Out-Null
if (Test-Path (Join-Path $app '.git')) {
  Step "updating $app ($Branch)"
  Push-Location $app; git fetch -q --all; git reset -q --hard "origin/$Branch"; Pop-Location
} else {
  Step "cloning $Repo -> $app ($Branch)"
  git clone -q -b $Branch $Repo $app
}
Step 'npm ci (production)'
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
Push-Location $app; npm ci --omit=dev; Pop-Location

# 5. Pin the ControlPlane CA when it serves HTTPS (TOFU for the fetch; then pinned for the agent).
$caFile = ''
if ($ControlPlaneUrl -like 'https://*') {
  $caFile = Join-Path $InstallRoot 'tls\cp-ca.pem'
  Step 'pinning ControlPlane CA'
  $prev = [Net.ServicePointManager]::ServerCertificateValidationCallback
  try {
    [Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
    Invoke-WebRequest -UseBasicParsing -Uri "$ControlPlaneUrl/bootstrap/ca.pem" -OutFile $caFile
  } catch {
    Write-Warning "could not fetch CA ($($_.Exception.Message)); relying on the system trust store"
    $caFile = ''
  } finally {
    [Net.ServicePointManager]::ServerCertificateValidationCallback = $prev
  }
}

# 6. Runtime layout (junctions to the checked-out tree + version markers).
foreach ($d in @('agent', 'control-plane-agent')) { New-Item -ItemType Directory -Force -Path (Join-Path $InstallRoot $d) | Out-Null }
foreach ($c in @('agent', 'control-plane-agent')) {
  $link = Join-Path $InstallRoot "$c\current"
  if (Test-Path $link) { cmd /c rmdir "$link" 2>$null | Out-Null }
  cmd /c mklink /J "$link" "$app\$c" | Out-Null
}
'3.0.0' | Set-Content -NoNewline (Join-Path $app 'agent\VERSION')
'3.0.0' | Set-Content -NoNewline (Join-Path $app 'control-plane-agent\VERSION')

# 7. Enroll (exchange the token for a durable node credential + persist identity).
Step "enrolling $NodeName ($NodeType)"
$onboard = Join-Path $InstallRoot 'onboard.mjs'
@'
import os from "node:os";
const { enrollNode, persistIdentity } = await import(process.env.WI_ENROLL_MODULE);
const identity = { nodeName: process.env.WI_NAME, nodeType: process.env.WI_TYPE, platform: "windows", machineId: os.hostname(), os: `${os.type()} ${os.release()}` };
const enr = await enrollNode(process.env.WI_CP, process.env.WI_TOKEN, identity);
await persistIdentity(process.env.WI_ROOT, { ...identity, controlPlaneUrl: process.env.WI_CP, ...enr });
console.log("[install-agent] enrolled " + enr.nodeId);
'@ | Set-Content -Encoding UTF8 $onboard
$env:NODE_EXTRA_CA_CERTS = $caFile
$env:WI_ENROLL_MODULE = "file:///$(($app -replace '\\','/'))/bootstrap/enroll.mjs"
$env:WI_CP = $ControlPlaneUrl; $env:WI_ROOT = $InstallRoot; $env:WI_NAME = $NodeName; $env:WI_TYPE = $NodeType; $env:WI_TOKEN = $EnrollmentToken
& node $onboard
if ($LASTEXITCODE -ne 0) { throw "enrollment failed (exit $LASTEXITCODE)" }

# 8. Run the supervisor as a SYSTEM scheduled task (auto-start + auto-restart). A small wrapper
#    .cmd carries the environment so the task launches with a stable, explicit context.
$nodeExe = (Get-Command node).Source
$wrapper = Join-Path $InstallRoot 'run-agent.cmd'
$caLine = if ($caFile) { "set NODE_EXTRA_CA_CERTS=$caFile" } else { 'rem no CA (plain HTTP or system trust)' }
@"
@echo off
set WEBINSPECTOR_INSTALL_ROOT=$InstallRoot
$caLine
set WEBINSPECTOR_SKIP_METADATA_LOOKUPS=1
cd /d "$app"
"$nodeExe" control-plane-agent\core\index.mjs
"@ | Set-Content -Encoding ASCII $wrapper

$action    = New-ScheduledTaskAction -Execute $wrapper
$trigger   = New-ScheduledTaskTrigger -AtStartup
$principalT = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'WebInspector-Agent' -Action $action -Trigger $trigger -Principal $principalT -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'WebInspector-Agent'
Step "registered + started scheduled task 'WebInspector-Agent'"

if ($env:WEBINSPECTOR_SKIP_BROWSER -ne '1') {
  Step 'installing Chromium for browser validation (set WEBINSPECTOR_SKIP_BROWSER=1 to skip)'
  try { Push-Location $app; npx --yes playwright install chromium | Out-Null; Pop-Location; Step 'chromium ready' }
  catch { Write-Warning 'chromium install failed; browser validation will be unavailable until installed' }
}

Step 'done — the ControlPlane will show this node once its heartbeat lands.'
