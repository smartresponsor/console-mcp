$ErrorActionPreference='Stop'
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
  & node (Join-Path $PWD 'node_modules/typescript/bin/tsc') -p tsconfig.json
  if($LASTEXITCODE -ne 0){throw 'EBAY_STORE_TYPESCRIPT_BUILD_FAILED'}
  & node tool/ebay-store-routing-regression.mjs
  if($LASTEXITCODE -ne 0){throw 'EBAY_STORE_REGRESSION_FAILED'}
  & node tool/ebay-store-session-regression.mjs
  if($LASTEXITCODE -ne 0){throw 'EBAY_STORE_SESSION_REGRESSION_FAILED'}
  & node tool/ebay-store-worker-regression.mjs
  if($LASTEXITCODE -ne 0){throw 'EBAY_STORE_WORKER_REGRESSION_FAILED'}
  & node tool/ebay-store-journal-regression.mjs
  if($LASTEXITCODE -ne 0){throw 'EBAY_STORE_JOURNAL_REGRESSION_FAILED'}
  & node tool/ebay-listing-selection-regression.mjs
  if($LASTEXITCODE -ne 0){throw 'EBAY_LISTING_SELECTION_REGRESSION_FAILED'}
  & node tool/ebay-attested-target-regression.mjs
  if($LASTEXITCODE -ne 0){throw 'EBAY_ATTESTED_TARGET_REGRESSION_FAILED'}
  & node tool/ebay-listing-evidence-regression.mjs
  if($LASTEXITCODE -ne 0){throw 'EBAY_LISTING_EVIDENCE_REGRESSION_FAILED'}
  & node tool/ebay-listing-observation-regression.mjs
  if($LASTEXITCODE -ne 0){throw 'EBAY_LISTING_OBSERVATION_REGRESSION_FAILED'}
  & node tool/ebay-form-specific-regression.mjs
  if($LASTEXITCODE -ne 0){throw 'EBAY_FORM_SPECIFIC_REGRESSION_FAILED'}
} finally { Pop-Location }
