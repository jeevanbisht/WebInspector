<#
.SYNOPSIS
  WebInspector zero-touch node bootstrap (Windows).

.DESCRIPTION
  Tiny installer an admin — or automation (Azure VM Custom Script Extension, cloud-init,
  GPO startup script) — runs on a fresh VM to onboard it into the WebInspector control
  plane. It ensures Node.js is present, downloads the cross-platform bootstrap, and runs
  it. The bootstrap installs the ControlPlane Agent as an auto-start service and enrolls
  the node; the control plane then converges it to desired state with no further steps.

  All parameters fall back to environment variables so the script works unattended and via
  `iwr <url>/bootstrap/install.ps1 | iex`.

.EXAMPLE
  # Interactive
  .\install.ps1 -ControlPlaneUrl http://cp:8787 -EnrollmentToken <token> -NodeType azure_direct

.EXAMPLE
  # Unattended one-liner (token via env)
  $env:WEBINSPECTOR_CONTROLPLANE_URL='http://cp:8787'
  $env:WEBINSPECTOR_ENROLLMENT_TOKEN='<token>'
  $env:WEBINSPECTOR_NODE_TYPE='azure_direct'
  iwr http://cp:8787/bootstrap/install.ps1 | iex
#>
[CmdletBinding()]
param(
  [string]$ControlPlaneUrl = $env:WEBINSPECTOR_CONTROLPLANE_URL,
  [string]$EnrollmentToken = $env:WEBINSPECTOR_ENROLLMENT_TOKEN,
  [string]$NodeName        = $env:WEBINSPECTOR_NODE_NAME,
  [string]$NodeType        = $env:WEBINSPECTOR_NODE_TYPE,
  [string]$InstallRoot     = $(if ($env:WEBINSPECTOR_INSTALL_ROOT) { $env:WEBINSPECTOR_INSTALL_ROOT } else { 'C:\WebInspector' })
)

$ErrorActionPreference = 'Stop'

function Write-Step($m) { Write-Host "[bootstrap] $m" }

# 1. Require admin (needed to install a service and grant reboot rights).
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'install.ps1 must run as Administrator.'
}

# 2. Validate required inputs.
if (-not $ControlPlaneUrl) { throw 'ControlPlaneUrl is required (-ControlPlaneUrl or WEBINSPECTOR_CONTROLPLANE_URL).' }
if (-not $EnrollmentToken) { throw 'EnrollmentToken is required (-EnrollmentToken or WEBINSPECTOR_ENROLLMENT_TOKEN).' }
if (-not $NodeType)        { throw 'NodeType is required (-NodeType or WEBINSPECTOR_NODE_TYPE).' }
if (-not $NodeName)        { $NodeName = $env:COMPUTERNAME }
$ControlPlaneUrl = $ControlPlaneUrl.TrimEnd('/')

# 3. Ensure Node.js runtime.
# TODO(zero-touch): auto-provision a pinned Node runtime if absent (bundled msi / winget)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js not found. Install Node 18+ (or enable the pinned-runtime provisioning TODO).'
}

# 4. Download the tiny cross-platform bootstrap orchestrator.
$bootstrapDir = Join-Path $InstallRoot 'bootstrap'
New-Item -ItemType Directory -Force -Path $bootstrapDir | Out-Null
$bootstrapPath = Join-Path $bootstrapDir 'bootstrap.mjs'
Write-Step "downloading bootstrap from $ControlPlaneUrl/bootstrap/bootstrap.mjs"
Invoke-WebRequest -UseBasicParsing -Uri "$ControlPlaneUrl/bootstrap/bootstrap.mjs" -OutFile $bootstrapPath

# 5. Run it — it verifies + installs the supervisor, enrolls the node, and starts the service.
Write-Step "onboarding $NodeName ($NodeType)"
& node $bootstrapPath --url $ControlPlaneUrl --token $EnrollmentToken --node-name $NodeName --node-type $NodeType --install-root $InstallRoot
if ($LASTEXITCODE -ne 0) { throw "bootstrap.mjs failed with exit code $LASTEXITCODE" }

Write-Step 'done — node is enrolled; the control plane will finish onboarding automatically.'
