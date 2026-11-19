param([switch]$OAuthDiagnostic, [switch]$ReleaseMetadataDiagnostic, [switch]$SealedInventoryAcceptance, [switch]$GitReview, [switch]$CleanGeneratedBytecode, [switch]$CommitReviewed)
$ErrorActionPreference='Stop'
if ($CommitReviewed) {
  $root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
  $paths=@('ops/ubuntu/deployment/stage09-authorize-validate.py','tool/runtime-deployment-preflight-regression.ps1','tool/stage09-policy-fixture-test.py','tool/stage09-test-local.ps1')
  & git -c "safe.directory=$root" diff --check
  if ($LASTEXITCODE -ne 0) { throw 'DIFF_CHECK_FAILED' }
  & git -c "safe.directory=$root" add -- $paths
  if ($LASTEXITCODE -ne 0) { throw 'GIT_ADD_FAILED' }
  & git -c "safe.directory=$root" diff --cached --check
  if ($LASTEXITCODE -ne 0) { throw 'STAGED_DIFF_CHECK_FAILED' }
  & git -c "safe.directory=$root" commit -m 'fix(stage09): pin sealed inventory and reject symlink races'
  if ($LASTEXITCODE -ne 0) { throw 'GIT_COMMIT_FAILED' }
  & git -c "safe.directory=$root" rev-parse HEAD
  exit $LASTEXITCODE
}
if ($CleanGeneratedBytecode) {
  $dir=Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')).Path 'ops/ubuntu/deployment/__pycache__'
  if (Test-Path -LiteralPath $dir) {
    $items=Get-ChildItem -LiteralPath $dir -Force
    if (@($items | Where-Object { $_.PSIsContainer -or $_.Extension -ne '.pyc' }).Count -ne 0) { throw 'UNEXPECTED_BYTECODE_DIRECTORY_CONTENTS' }
    Remove-Item -LiteralPath $dir -Recurse -Force
    Write-Output 'ISOLATED_BYTECODE_CLEANED'
  }
  exit 0
}
if ($GitReview) {
  $root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
  & git -c "safe.directory=$root" status --short
  & git -c "safe.directory=$root" rev-parse HEAD
  & git -c "safe.directory=$root" branch --show-current
  & git -c "safe.directory=$root" diff --check
  & git -c "safe.directory=$root" diff --stat
  exit $LASTEXITCODE
}
if ($SealedInventoryAcceptance) {
  & /usr/bin/python3 -I -B -c @'
import importlib.util,json,pathlib,hashlib,sys
p=pathlib.Path("ops/ubuntu/deployment/stage09-authorize-validate.py")
spec=importlib.util.spec_from_file_location("stage09_acceptance",p)
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
for sha in (m.SHA,m.ROLLBACK):
 release=m.BASE/"releases"/sha
 fd=m.open_sealed_file(release/"release.json")
 try:
  import os
  with os.fdopen(fd,"rb") as h: raw=h.read(1048577)
  assert len(raw)<=1048576
  manifest=json.loads(raw)
  assert manifest["sourceCommit"]==sha
  actual=m.sealed_inventory(release)
  expected=manifest["files"]
  assert actual==expected, "INVENTORY_MISMATCH:"+str(len(actual))+":"+str(len(expected))
  print(json.dumps({"sha":sha,"files":len(actual),"symlinks":sum(v.startswith("link:") for v in actual.values()),"manifestSha256":hashlib.sha256(raw).hexdigest(),"status":"SEALED_INVENTORY_PASS"}))
 except Exception as e:
  print(json.dumps({"sha":sha,"status":"SEALED_INVENTORY_FAIL","reason":type(e).__name__+":"+str(e)[:180]}))
  raise
'@
  exit $LASTEXITCODE
}
if ($ReleaseMetadataDiagnostic) {
  & /usr/bin/python3 -I -B -c @'
import os, pathlib, stat, json
for name in ('/opt/console-mcp-deploy/release-store.json','/opt/console-mcp-deploy/registry.json','/opt/console-mcp-deploy/releases','/home/alex/smartresponse/mcp/.releases'):
 p=pathlib.Path(name)
 try:
  s=p.lstat()
  print(json.dumps({'path':name,'uid':s.st_uid,'gid':s.st_gid,'mode':oct(stat.S_IMODE(s.st_mode)),'type':'symlink' if stat.S_ISLNK(s.st_mode) else 'directory' if stat.S_ISDIR(s.st_mode) else 'file','readable':os.access(p,os.R_OK)}))
  if p.is_dir():
   for c in sorted(p.iterdir())[:12]:
    x=c.lstat()
    print(json.dumps({'member':c.name,'parent':name,'uid':x.st_uid,'mode':oct(stat.S_IMODE(x.st_mode)),'symlink':stat.S_ISLNK(x.st_mode)}))
  elif p.name=='release-store.json' and os.access(p,os.R_OK):
   print('RELEASE_STORE_POLICY='+p.read_text()[:2048])
 except (OSError,PermissionError) as e:
  print(json.dumps({'path':name,'error':type(e).__name__,'errno':getattr(e,'errno',None)}))
'@
  & /usr/bin/python3 -I -B -c @'
import pathlib,os,stat,json
base=pathlib.Path('/opt/console-mcp-deploy/releases')
for sha in ('eb5e062023cb40341fc75b56ce26524a9a529f16','df90d4706bf3c476ddcf9ef6ba09f6be039d8fec'):
 root=base/sha
 try:
  print('SEALED_ROOT',sha,'exists',root.exists())
  if root.exists():
   manifest=root/'release.json'
   print('MANIFEST',manifest.exists(),oct(stat.S_IMODE(manifest.stat().st_mode)) if manifest.exists() else None)
   if manifest.exists():
    doc=json.loads(manifest.read_bytes()[:1048576])
    files=doc.get('files',{})
    print('INVENTORY',len(files),'links',sum(isinstance(v,str) and v.startswith('link:') for v in files.values()),'keys',list(doc.keys()))
    for k,v in files.items():
     if isinstance(v,str) and v.startswith('link:'):
      p=root/k
      print('LINK',json.dumps({'path':k,'manifestTarget':v,'actualTarget':os.readlink(p),'isWithin':p.resolve().is_relative_to(root.resolve())}))
 except Exception as e: print('SEALED_INSPECTION_ERROR',sha,type(e).__name__,str(e)[:180])
'@
  exit $LASTEXITCODE
}
if ($OAuthDiagnostic) {
  & node tool/oauth-smoke-test.mjs
  if ($LASTEXITCODE -ne 0) { throw "STAGE09_OAUTH_DIAGNOSTIC_FAILED_EXIT_$LASTEXITCODE" }
  Write-Output 'STAGE09_OAUTH_DIAGNOSTIC_PASS'
  exit 0
}
Write-Output ('UID='+(& id -u))
$helper='ops/ubuntu/deployment/stage09-authorize-validate.py'
$test='tool/stage09-policy-fixture-test.py'
& /usr/bin/python3 -I -B -c 'import ast, pathlib, sys; [ast.parse(pathlib.Path(p).read_text()) for p in sys.argv[1:]]; print("STAGE09_PYTHON_SYNTAX_PASS")' $helper $test
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
& /usr/bin/python3 -I -B $test
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
$out = & /usr/bin/python3 -I -B $helper --inspect 2>&1
if($LASTEXITCODE -eq 0 -or (($out | Out-String) -notmatch 'ADMIN_ROOT_SESSION_REQUIRED')){throw 'ROOT_BOUNDARY_NOT_ENFORCED'}
Write-Output 'STAGE09_SERVICE_UID_DENIED_PASS'
Write-Output ('STAGE09_HELPER_SHA256='+((& sha256sum $helper) -split ' ')[0])
Write-Output 'STAGE09_LOCAL_FIXTURE_PASS'
