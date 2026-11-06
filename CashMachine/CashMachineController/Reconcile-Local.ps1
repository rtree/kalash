param(
  [Parameter(Mandatory)]
  [ValidateRange(1, 2147483647)]
  [int]$ServerPid
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$serverDirectory = Join-Path $repositoryRoot 'CashMachine\RESTAPIServer'
$freshPackageDirectory = Join-Path $repositoryRoot '_do_not_redistribute_\Fresh-ITL_SDK_Package_v3.2.9'
$project = Join-Path $PSScriptRoot 'KALASH.CashMachineController.csproj'
$dotnet = (Get-Command dotnet.exe -CommandType Application -ErrorAction Stop).Source
$serverDll = Join-Path $serverDirectory 'CashDevice-RestAPI.dll'
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$ServerPid"

if (-not $process -or $process.Name -ine 'dotnet.exe' -or -not $process.CommandLine.Contains($serverDll, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The supplied PID does not run the dedicated KALASH REST API Server; refusing to attach.'
}

$listeners = @(Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count -eq 0 -or @($listeners | Where-Object OwningProcess -ne $ServerPid).Count -gt 0) {
  throw 'Port 5000 is not exclusively owned by the supplied server PID; refusing to attach.'
}

$variables = @(
  'KALASH_ITL_REST_SERVER_DIR',
  'KALASH_ITL_DOTNET',
  'KALASH_ITL_FRESH_PACKAGE_DIR',
  'KALASH_ITL_EXPECTED_SERVER_PID'
)
$previous = @{}
$exitCode = 1

foreach ($name in $variables) {
  $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

Push-Location $repositoryRoot
try {
  $env:KALASH_ITL_REST_SERVER_DIR = $serverDirectory
  $env:KALASH_ITL_DOTNET = $dotnet
  $env:KALASH_ITL_FRESH_PACKAGE_DIR = $freshPackageDirectory
  $env:KALASH_ITL_EXPECTED_SERVER_PID = "$ServerPid"

  node scripts\check-policy.mjs
  if ($LASTEXITCODE -ne 0) {
    throw 'Policy check failed; the existing server was not queried.'
  }

  dotnet run --project $project -- reconcile
  $exitCode = $LASTEXITCODE
}
finally {
  foreach ($name in $variables) {
    if ($null -eq $previous[$name]) {
      Remove-Item "Env:\$name" -ErrorAction SilentlyContinue
    }
    else {
      [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process')
    }
  }
  Pop-Location
}

exit $exitCode
