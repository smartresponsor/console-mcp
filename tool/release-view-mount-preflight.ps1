$ErrorActionPreference='Stop'
& /usr/bin/systemd-escape --path --suffix=mount /home/alex/smartresponse/mcp/.releases
& /usr/bin/findmnt --noheadings --output TARGET,SOURCE,FSTYPE,OPTIONS /opt/console-mcp-deploy/releases
& /usr/bin/findmnt --noheadings --output TARGET,SOURCE,FSTYPE,OPTIONS /home/alex/smartresponse/mcp/.releases
exit 0
