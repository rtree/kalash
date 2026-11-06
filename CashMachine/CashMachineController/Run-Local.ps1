[CmdletBinding()]
param([switch]$OneHundred)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$project = Join-Path $PSScriptRoot 'KALASH.CashMachineController.csproj'
$dotnet = (Get-Command dotnet.exe -CommandType Application -ErrorAction Stop).Source
$variables = @('KALASH_ITL_REST_SERVER_DIR', 'KALASH_ITL_DOTNET', 'KALASH_ITL_FRESH_PACKAGE_DIR')
$previous = @{}
$exitCode = 1
foreach ($name in $variables) {
    $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

if ($OneHundred -and $env:KALASH_PRODUCT_CASH_ENABLE -cne 'OWNER_ATTENDED_PRODUCT_CASH') {
    throw 'The one-100 restriction does not enable cash. Explicit owner-attended product authorization is required.'
}

Push-Location $repositoryRoot
try {
    $env:KALASH_ITL_REST_SERVER_DIR = Join-Path $repositoryRoot 'CashMachine\RESTAPIServer'
    $env:KALASH_ITL_DOTNET = $dotnet
    $env:KALASH_ITL_FRESH_PACKAGE_DIR = Join-Path $repositoryRoot '_do_not_redistribute_\Fresh-ITL_SDK_Package_v3.2.9'
    node scripts\check-policy.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Policy check failed; Controller was not started.' }
    $runArguments = @('run')
    if ($OneHundred) { $runArguments += '--one-100' }
    & $dotnet run --project $project --no-restore -- @runArguments
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
