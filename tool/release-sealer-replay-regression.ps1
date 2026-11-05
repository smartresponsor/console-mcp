$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/84-release-v3-seal-request.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/79-release-v3-sealer-replay.ps1')
$now=[datetimeoffset]::UtcNow
$req=@{schema_version=1;operation='seal_new_release';request_id=('a'*32);source_sha=('b'*40);payload_inventory_sha256=('c'*64);release_id=('d'*40);rollback_release_id=('e'*40);expires_at=$now.AddMinutes(5).ToString('o');authority_mac=('f'*64)}
$journal=@{schema_version=1;records=@()}
$proposal=Get-ReleaseV3SealReplayReservation -Journal $journal -Request $req
if($proposal.reservation.sequence -ne 1 -or $proposal.reservation_persisted -or $proposal.authorization_granted -or $proposal.journal_authenticated){throw 'REPLAY_PROPOSAL_OVERCLAIMS_AUTHORITY'}
$journal.records=@($proposal.reservation)
$proof=Assert-ReleaseV3SealReplayJournal -Journal $journal
if($proof.record_count -ne 1 -or $proof.authenticated){throw 'REPLAY_JOURNAL_PROOF_INVALID'}
$blocked=$false
try{$null=Get-ReleaseV3SealReplayReservation -Journal $journal -Request $req}catch{$blocked=$_.Exception.Message -eq 'RELEASE_SEAL_REPLAY_REQUEST_CONSUMED'}
if(-not $blocked){throw 'DUPLICATE_REQUEST_ACCEPTED'}
$other=$req.Clone();$other.request_id='1'*32
$blocked=$false
try{$null=Get-ReleaseV3SealReplayReservation -Journal $journal -Request $other}catch{$blocked=$_.Exception.Message -eq 'RELEASE_SEAL_REPLAY_RELEASE_CONSUMED'}
if(-not $blocked){throw 'RELEASE_ID_REUSE_ACCEPTED'}
$bad=@{schema_version=1;records=@($proposal.reservation,$proposal.reservation)}
$blocked=$false
try{$null=Assert-ReleaseV3SealReplayJournal -Journal $bad}catch{$blocked=$true}
if(-not $blocked){throw 'DUPLICATE_JOURNAL_RECORD_ACCEPTED'}
$bad=@{schema_version=1;records=@(([hashtable]@{sequence=$proposal.reservation.sequence;request_id=$proposal.reservation.request_id;release_id=$proposal.reservation.release_id;source_sha=$proposal.reservation.source_sha;inventory_sha256=$proposal.reservation.inventory_sha256;phase=$proposal.reservation.phase}))}
$bad.records[0].sequence=9
$blocked=$false
try{$null=Assert-ReleaseV3SealReplayJournal -Journal $bad}catch{$blocked=$true}
if(-not $blocked){throw 'BROKEN_SEQUENCE_ACCEPTED'}
$bad=@{schema_version=1;records=@(([hashtable]@{sequence=$proposal.reservation.sequence;request_id=$proposal.reservation.request_id;release_id=$proposal.reservation.release_id;source_sha=$proposal.reservation.source_sha;inventory_sha256=$proposal.reservation.inventory_sha256;phase=$proposal.reservation.phase}))}
$bad.records[0].phase='UNKNOWN'
$blocked=$false
try{$null=Assert-ReleaseV3SealReplayJournal -Journal $bad}catch{$blocked=$true}
if(-not $blocked){throw 'UNKNOWN_PHASE_ACCEPTED'}
'RELEASE_SEALER_REPLAY_REGRESSION_PASS'
