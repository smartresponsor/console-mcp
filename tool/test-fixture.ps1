# Cleanup is a capability for a fresh directory created by this process, never a path permission.
if(-not (Get-Variable ConsoleTestFixtureOwners -Scope Script -ErrorAction SilentlyContinue)){
    $script:ConsoleTestFixtureOwners=@{}
}
function New-ConsoleTestFixture {
    param([ValidatePattern('^[a-z][a-z0-9-]{0,64}$')][string]$Prefix='console-test',[string]$Parent=[IO.Path]::GetTempPath())
    $parent=[IO.Path]::GetFullPath($Parent).TrimEnd('\','/')
    $path=Join-Path $parent ($Prefix+'-'+[guid]::NewGuid().ToString('N'))
    if(Test-Path -LiteralPath $path){throw 'FIXTURE_ALREADY_EXISTS'}
    $null=[IO.Directory]::CreateDirectory($path)
    if(-not $IsWindows){[IO.File]::SetUnixFileMode($path,[IO.UnixFileMode]448)}
    $token=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    [IO.File]::WriteAllText((Join-Path $path '.console-test-owner'),$token)
    $script:ConsoleTestFixtureOwners[$path]=@{token=$token;parent=$parent}
    return $path
}
function Remove-ConsoleTestFixture {
    param([Parameter(Mandatory=$true)][string]$Path)
    $resolved=[IO.Path]::GetFullPath($Path).TrimEnd('\','/')
    if(-not $script:ConsoleTestFixtureOwners.ContainsKey($resolved)){throw 'FIXTURE_NOT_OWNED'}
    $owner=$script:ConsoleTestFixtureOwners[$resolved]
    if([IO.Path]::GetDirectoryName($resolved) -cne $owner.parent){throw 'FIXTURE_PARENT_CHANGED'}
    $cursor=[IO.DirectoryInfo]::new($resolved)
    while($null -ne $cursor){
        if($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'FIXTURE_REPARSE_POINT'}
        $cursor=$cursor.Parent
    }
    $marker=Join-Path $resolved '.console-test-owner'
    if((Get-Item -LiteralPath $marker -Force -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'FIXTURE_REPARSE_POINT'}
    if(-not [IO.File]::Exists($marker) -or [IO.File]::ReadAllText($marker) -cne $owner.token){throw 'FIXTURE_OWNER_CHANGED'}
    $members=@(Get-ChildItem -LiteralPath $resolved -Recurse -Force -ErrorAction Stop)
    if(@($members | Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint}).Count){throw 'FIXTURE_REPARSE_POINT'}
    # Git test objects may be read-only. Only proven-owned, non-linked members are made writable.
    foreach($member in $members){$member.Attributes=$member.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly)}
    [IO.Directory]::Delete($resolved,$true)
    $script:ConsoleTestFixtureOwners.Remove($resolved)
}
