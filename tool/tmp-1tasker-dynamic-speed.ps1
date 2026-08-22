$ErrorActionPreference='Stop'
$root='D:\PhpstormProjects\www\_audio\1tasker-intro'
$src=Join-Path $root 'sources'
$ffmpeg=Get-ChildItem (Join-Path $root 'tools') -Filter ffmpeg.exe -Recurse | Select-Object -First 1
if(-not $ffmpeg){throw 'ffmpeg not found'}
function F([string]$name){ Join-Path $src $name }
$files=@((F 'driveby.mp3'),(F 'doorbell.mp3'),(F 'door_open.mp3'),(F 'dialog_us_male_female.ogg'),(F 'steps_walk_real.ogg'),(F 'prep_paper.mp3'),(F 'tape_measure.mp3'),(F 'tool_click.mp3'),(F 'hammer.mp3'),(F 'drill.mp3'),(F 'saw.mp3'),(F 'screwer.mp3'),(F 'dialog_us_male_female.ogg'),(F 'payment_terminal.mp3'),(F 'payment_success.mp3'),(F 'steps_walk_real.ogg'),(F 'dialog_us_male_female.ogg'),(F 'door_close.mp3'),(F 'car_door.mp3'),(F 'cash.mp3'),(F 'cash2.mp3'),(F 'engine.mp3'),(F 'driveby.mp3'))
$args=@('-y'); foreach($f in $files){$args+=@('-i',$f)}
$flt=@(
'[0:a]atrim=0:2.4,asetpts=PTS-STARTPTS,asetrate=110250,aresample=44100[a0]',
'[1:a]atrim=0:2.3,asetpts=PTS-STARTPTS,asetrate=88200,aresample=44100[a1]',
'[2:a]atrim=0:2.2,asetpts=PTS-STARTPTS,asetrate=88200,aresample=44100[a2]',
'[3:a]atrim=0:5.8,asetpts=PTS-STARTPTS,asetrate=176400,aresample=44100[a3]',
'[4:a]atrim=0:3.5,asetpts=PTS-STARTPTS,asetrate=88200,aresample=44100[a4]',
'[4:a]atrim=0:3.5,asetpts=PTS-STARTPTS,asetrate=88200,aresample=44100[a5]',
'[5:a]atrim=0:1.8,asetpts=PTS-STARTPTS,asetrate=132300,aresample=44100[a6]',
'[6:a]atrim=0:1.1,asetpts=PTS-STARTPTS,asetrate=132300,aresample=44100[a7]',
'[7:a]atrim=0:1.8,asetpts=PTS-STARTPTS,asetrate=132300,aresample=44100[a8]',
'[8:a]atrim=0:0.47,asetpts=PTS-STARTPTS,asetrate=132300,aresample=44100[a9]',
'[9:a]atrim=0.2:3.2,asetpts=PTS-STARTPTS,asetrate=132300,aresample=44100[a10]',
'[10:a]atrim=0:1.7,asetpts=PTS-STARTPTS,asetrate=132300,aresample=44100[a11]',
'[11:a]atrim=0:1.5,asetpts=PTS-STARTPTS,asetrate=132300,aresample=44100[a12]',
'[12:a]atrim=6.0:11.5,asetpts=PTS-STARTPTS,asetrate=176400,aresample=44100[a13]',
'[13:a]atrim=0:1.3,asetpts=PTS-STARTPTS,asetrate=88200,aresample=44100[a14]',
'[14:a]atrim=0:1.0,asetpts=PTS-STARTPTS,asetrate=88200,aresample=44100[a15]',
'[15:a]atrim=0:3.5,asetpts=PTS-STARTPTS,asetrate=88200,aresample=44100[a16]',
'[15:a]atrim=0:3.5,asetpts=PTS-STARTPTS,asetrate=88200,aresample=44100[a17]',
'[16:a]atrim=12.0:17.5,asetpts=PTS-STARTPTS,asetrate=176400,aresample=44100[a18]',
'[17:a]atrim=0:0.46,asetpts=PTS-STARTPTS,asetrate=88200,aresample=44100[a19]',
'[18:a]atrim=0:0.71,asetpts=PTS-STARTPTS,asetrate=88200,aresample=44100[a20]',
'[19:a]atrim=0.3:3.4,asetpts=PTS-STARTPTS,asetrate=88200,aresample=44100[a21]',
'[20:a]atrim=0:2.8,asetpts=PTS-STARTPTS,asetrate=88200,aresample=44100[a22]',
'[21:a]atrim=0:2.5,asetpts=PTS-STARTPTS,asetrate=88200,aresample=44100[a23]',
'[22:a]atrim=0:3.7,asetpts=PTS-STARTPTS,asetrate=110250,aresample=44100[a24]',
'[a0][a1][a2][a3][a4][a5][a6][a7][a8][a9][a10][a11][a12][a13][a14][a15][a16][a17][a18][a19][a20][a21][a22][a23][a24]concat=n=25:v=0:a=1[out]') -join ';'
$out=Join-Path $root '1tasker-real-foley-storyboard-v4-dynamic-speed.mp3'
$args+=@('-filter_complex',$flt,'-map','[out]','-ar','44100','-ac','2','-c:a','libmp3lame','-b:a','128k',$out)
& $ffmpeg.FullName @args
