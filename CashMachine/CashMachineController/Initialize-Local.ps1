$ErrorActionPreference = 'Stop'

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$serverDirectory = Join-Path $repositoryRoot 'CashMachine\RESTAPIServer'
$freshPackageDirectory = Join-Path $repositoryRoot '_do_not_redistribute_\Fresh-ITL_SDK_Package_v3.2.9'
$project = Join-Path $PSScriptRoot 'KALASH.CashMachineController.csproj'
$dotnet = (Get-Command dotnet.exe -CommandType Application -ErrorAction Stop).Source
$variables = @(
  'KALASH_ITL_REST_SERVER_DIR',
  'KALASH_ITL_DOTNET',
  'KALASH_ITL_FRESH_PACKAGE_DIR'
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

  node scripts\check-policy.mjs
  if ($LASTEXITCODE -ne 0) {
    throw 'Policy check failed; the REST API Server was not started.'
  }

  dotnet run --project $project -- initialize
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
