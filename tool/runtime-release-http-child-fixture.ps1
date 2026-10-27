param([Parameter(Mandatory=$true)][int]$Port)
$ErrorActionPreference = 'Stop'
$tcp = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
try {
    $tcp.Start()
    while ($true) {
        $client = $tcp.AcceptTcpClient()
        try {
            $stream = $client.GetStream()
            $buffer = New-Object byte[] 2048
            $null = $stream.Read($buffer, 0, $buffer.Length)
            $payload = [System.Text.Encoding]::ASCII.GetBytes("HTTP/1.1 200 OK`r`nContent-Length: 7`r`nConnection: close`r`n`r`nhealthy")
            $stream.Write($payload, 0, $payload.Length)
            $stream.Flush()
        } finally { $client.Close() }
    }
} finally { $tcp.Stop() }
