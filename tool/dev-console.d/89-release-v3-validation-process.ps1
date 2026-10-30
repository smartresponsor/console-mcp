function Invoke-ReleaseV3ValidationProcess {
    param([string]$Script,[string[]]$Arguments,[string]$WorkingDirectory,[string]$Log,[scriptblock]$Pulse,[int]$TimeoutSeconds=900)
    $start=[Diagnostics.ProcessStartInfo]::new((Get-Command pwsh).Source)
    $start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.WorkingDirectory=$WorkingDirectory
    $start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
    foreach($arg in @('-NoProfile','-NonInteractive','-File',$Script)+$Arguments){$start.ArgumentList.Add($arg)}
    $child=[Diagnostics.Process]::new();$child.StartInfo=$start;$started=$false
    try{
        $started=$child.Start()
        if(-not $started){throw 'RELEASE_VALIDATION_PROCESS_NOT_STARTED'}
        $stdout=$child.StandardOutput.ReadToEndAsync();$stderr=$child.StandardError.ReadToEndAsync()
        $deadline=[datetime]::UtcNow.AddSeconds($TimeoutSeconds)
        while(-not $child.WaitForExit(500)){
            & $Pulse | Out-Null
            if([datetime]::UtcNow -ge $deadline){throw 'RELEASE_VALIDATION_PROCESS_TIMEOUT'}
        }
        & $Pulse | Out-Null
        if(-not $stdout.Wait(5000) -or -not $stderr.Wait(5000)){throw 'RELEASE_VALIDATION_OUTPUT_NOT_CLOSED'}
        $output=$stdout.GetAwaiter().GetResult();$errorOutput=$stderr.GetAwaiter().GetResult()
        [IO.File]::WriteAllText($Log,$output+[Environment]::NewLine+$errorOutput)
        return @{exitCode=$child.ExitCode;stdout=$output}
    } finally {
        if($started -and -not $child.HasExited){$child.Kill($true);$null=$child.WaitForExit(5000)}
        $child.Dispose()
    }
}
