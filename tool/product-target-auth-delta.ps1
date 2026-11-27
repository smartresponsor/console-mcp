$ErrorActionPreference='Stop'
& node --experimental-strip-types --test tool/product-target-auth-regression.mjs
exit $LASTEXITCODE
