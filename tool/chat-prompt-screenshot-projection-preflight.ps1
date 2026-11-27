$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
& node (Join-Path $root 'tool/console-tool-admission-projection-cli.mjs') --write
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
foreach ($test in @('console-tool-admission-projection-cli.mjs','console-registration-ast-regression.mjs','validate-console-tool-catalog.mjs','validate-capability-admission.mjs')) {
    & node (Join-Path $root "tool/$test")
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
