$ErrorActionPreference='Stop'
Write-Output 'KERNEL_NAMESPACE_FLAGS:'
& /usr/bin/unshare --user --map-root-user --mount --fork /usr/bin/id -u
Write-Output ('UNSHARE_EXIT=' + $LASTEXITCODE)
Write-Output 'USERNS_MAX:'
& /usr/bin/cat /proc/sys/user/max_user_namespaces
Write-Output 'UNPRIV_USERNS:'
if(Test-Path '/proc/sys/kernel/unprivileged_userns_clone'){& /usr/bin/cat /proc/sys/kernel/unprivileged_userns_clone}
Write-Output 'UNPRIV_RESTRICT:'
if(Test-Path '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'){& /usr/bin/cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns}
Write-Output 'MOUNT_NAMESPACE:'
& /usr/bin/readlink /proc/self/ns/mnt
exit 0
