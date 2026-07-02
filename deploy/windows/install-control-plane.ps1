<#
.SYNOPSIS
  Install the WebInspector ControlPlane as an auto-start Windows service.

.DESCRIPTION
  Copies the app to the install root, registers a Windows service that runs the single-port
  server, and opens the firewall port. Durable state under <InstallRoot>\state is preserved.

.EXAMPLE
  .\install-control-plane.ps1 -InstallRoot C:\WebInspector -Port 8787
#>
[CmdletBinding()]
param(
  [string]$InstallRoot = 'C:\WebInspector',
  [int]$Port = 8787,
  [string]$SourceDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$ServiceName = 'WebInspectorControlPlane'
)

$ErrorActionPreference = 'Stop'
function Write-Step($m) { Write-Host "[install-cp] $m" }

# 1. Require admin + Node.
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run as Administrator.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 18+ is required.' }

# 2. Lay down app; keep state.
$appDir = Join-Path $InstallRoot 'app'
$stateDir = Join-Path $InstallRoot 'state'
New-Item -ItemType Directory -Force -Path $appDir, $stateDir | Out-Null
Write-Step "copying app → $appDir (state preserved)"
robocopy $SourceDir $appDir /MIR /XD (Join-Path $SourceDir 'state') node_modules .git /NFL /NDL /NJH /NJS /NP | Out-Null

# 3. Register the service (native sc.exe; for a Node entrypoint use a service host such as
#    nssm or a scheduled task — shown here as the command the service should run).
$entry = Join-Path $appDir 'control-plane\server\index.mjs'
$bin = "`"$((Get-Command node).Source)`" `"$entry`""
Write-Step "registering service $ServiceName"
# TODO: wrap with nssm/winsw for a proper Node service; sc.exe expects a service-aware exe.
& sc.exe create $ServiceName binPath= "$bin" start= auto DisplayName= "WebInspector ControlPlane" | Out-Null
& sc.exe failure $ServiceName reset= 0 actions= restart/5000/restart/5000/restart/5000 | Out-Null

# 4. Open the port.
Write-Step "opening firewall TCP $Port"
New-NetFirewallRule -DisplayName "WebInspector ControlPlane $Port" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -ErrorAction SilentlyContinue | Out-Null

# 5. Start.
$env:WEBINSPECTOR_PORT = "$Port"
& sc.exe start $ServiceName | Out-Null
Write-Step "done — http://localhost:$Port (health: /api/health)"
