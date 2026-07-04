function Invoke-StackSnapshot {
    param([string]$Purpose = 'manual')
    $operationId = New-StackOperationId -Purpose $Purpose
    $browser = Invoke-BrowserEnsureVisible -Purpose $Purpose
    $stack = [pscustomobject]@{
        ok = [bool]$browser.ok
        operation_id = $operationId
        purpose = $Purpose
        at = (Get-Date).ToString('o')
        browser = $browser
    }
    $path = Write-StateArtifact -Directory $StackStateDir -Name $operationId -Payload $stack
    $stack | Add-Member -NotePropertyName stack_file -NotePropertyValue $path -Force
    return $stack
}

Set-Variable -Name DevConsoleStackModuleLoaded -Scope Script -Value $true -Force
