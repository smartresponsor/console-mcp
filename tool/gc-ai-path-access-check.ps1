$ErrorActionPreference='Stop'
& namei -l /home/alex/smartresponse/var/artifacts/uploads
& systemctl show console-mcp-visible-worker -p SupplementaryGroups -p ProtectHome -p ReadOnlyPaths -p ReadWritePaths --no-pager
& stat -c '%A %U %G %n' /home/alex/smartresponse/var/artifacts/uploads
