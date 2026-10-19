$ErrorActionPreference='Stop'
& /usr/bin/node tool/nellis-find-batch.mjs
if($LASTEXITCODE -ne 0){throw 'Nellis Find batch failed'}
