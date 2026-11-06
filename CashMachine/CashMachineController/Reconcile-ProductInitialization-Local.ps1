param(
    [Parameter(Mandatory)]
    [ValidateRange(1, 2147483647)]
    [int]$ServerPid
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$serverDirectory = Join-Path $repositoryRoot 'CashMachine\RESTAPIServer'
$serverDll = Join-Path $serverDirectory 'CashDevice-RestAPI.dll'
$project = Join-Path $PSScriptRoot 'KALASH.CashMachineController.csproj'
$dotnet = (Get-Command dotnet.exe -CommandType Application -ErrorAction Stop).Source
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$ServerPid"
if (-not $process -or $process.Name -ine 'dotnet.exe' -or
    -not $process.CommandLine.Contains($serverDll, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The supplied PID does not run the dedicated REST API Server; refusing to attach.'
}
$listeners = @(Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count -eq 0 -or @($listeners | Where-Object OwningProcess -ne $ServerPid).Count -gt 0) {
    throw 'Port 5000 is not exclusively owned by the supplied PID; refusing to attach.'
}

$variables = @('KALASH_ITL_REST_SERVER_DIR', 'KALASH_ITL_DOTNET', 'KALASH_ITL_FRESH_PACKAGE_DIR', 'KALASH_ITL_EXPECTED_SERVER_PID')
$previous = @{}
$exitCode = 1
foreach ($name in $variables) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
Push-Location $repositoryRoot
try {
    $env:KALASH_ITL_REST_SERVER_DIR = $serverDirectory
    $env:KALASH_ITL_DOTNET = $dotnet
    $env:KALASH_ITL_FRESH_PACKAGE_DIR = Join-Path $repositoryRoot '_do_not_redistribute_\Fresh-ITL_SDK_Package_v3.2.9'
    $env:KALASH_ITL_EXPECTED_SERVER_PID = "$ServerPid"
    node scripts\check-policy.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Policy check failed; no initialization reconciliation was attempted.' }
    & $dotnet run --project $project --no-restore -- reconcile-product-initialization
    $exitCode = $LASTEXITCODE
}
finally {
    foreach ($name in $variables) {
        if ($null -eq $previous[$name]) { Remove-Item "Env:\$name" -ErrorAction SilentlyContinue }
        else { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
    }
    Pop-Location
}
if ($exitCode -ne 0) { exit $exitCode }

$process = Get-CimInstance Win32_Process -Filter "ProcessId=$ServerPid"
if (-not $process -or $process.Name -ine 'dotnet.exe' -or
    -not $process.CommandLine.Contains($serverDll, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The verified disconnected server changed identity; refusing to stop it.'
}
$listeners = @(Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue)
if (@($listeners | Where-Object OwningProcess -ne $ServerPid).Count -gt 0) {
    throw 'Port ownership changed after disconnect; refusing to stop any process.'
}
Stop-Process -Id $ServerPid -Force
Wait-Process -Id $ServerPid -Timeout 10 -ErrorAction SilentlyContinue
if (Get-CimInstance Win32_Process -Filter "ProcessId=$ServerPid") {
    throw 'The verified disconnected child did not stop.'
}
if (@(Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue).Count -ne 0) {
    throw 'Port 5000 remains open after the verified child stopped.'
}
'Startup-only reconciliation completed; disconnected child stopped; evidence preserved. No automatic restart.'
exit 0
