$ErrorActionPreference='Stop'
foreach($path in @('/home/alex','/home/alex/smartresponse/var','/home/alex/smartresponse/var/artifacts','/home/alex/smartresponse/var/artifacts/uploads')){Write-Output ('PATH='+$path);& getfacl -cp $path 2>&1 | Where-Object {$_ -match '^(user:|group:|mask:|other:)' }}
