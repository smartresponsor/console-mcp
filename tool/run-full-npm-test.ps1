$ErrorActionPreference = "Stop"

& npm test
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
exit 0
