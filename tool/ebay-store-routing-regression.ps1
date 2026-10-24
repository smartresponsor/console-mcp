$ErrorActionPreference='Stop'
Push-Location '/home/alex/smartresponse/mcp/console-mcp'
try {
  & /usr/bin/npx --no-install tsc -p tsconfig.json
  if($LASTEXITCODE -ne 0){throw 'EBAY_STORE_TYPESCRIPT_BUILD_FAILED'}
  & /usr/bin/node tool/ebay-store-routing-regression.mjs
  if($LASTEXITCODE -ne 0){throw 'EBAY_STORE_REGRESSION_FAILED'}
  & /usr/bin/node tool/ebay-store-session-regression.mjs
  if($LASTEXITCODE -ne 0){throw 'EBAY_STORE_SESSION_REGRESSION_FAILED'}
  & /usr/bin/node tool/ebay-store-worker-regression.mjs
  if($LASTEXITCODE -ne 0){throw 'EBAY_STORE_WORKER_REGRESSION_FAILED'}
  & /usr/bin/node tool/ebay-store-journal-regression.mjs
  if($LASTEXITCODE -ne 0){throw 'EBAY_STORE_JOURNAL_REGRESSION_FAILED'}
  & /usr/bin/node tool/ebay-listing-selection-regression.mjs
  if($LASTEXITCODE -ne 0){throw 'EBAY_LISTING_SELECTION_REGRESSION_FAILED'}
  & /usr/bin/node tool/ebay-attested-target-regression.mjs
  if($LASTEXITCODE -ne 0){throw 'EBAY_ATTESTED_TARGET_REGRESSION_FAILED'}
} finally { Pop-Location }
