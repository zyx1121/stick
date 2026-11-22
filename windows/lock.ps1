# Lock C:\dev\fw: SYSTEM and Administrators only, owned by Administrators,
# with no other grant left anywhere inside. The daemon runs with the user's
# full rights, so anyone else who can write here, or read the token, can run
# code as that user. Throws instead of continuing with a weaker folder.
$root = 'C:\dev\fw'
$allowed = 'S-1-5-18', 'S-1-5-32-544'
$admins = New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544'
if (Test-Path -LiteralPath $root) {
    if ((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "$root is a link. Remove it, then install again." }
} else {
    New-Item -ItemType Directory -Path $root | Out-Null
}
# A new security descriptor replaces every entry, including grants someone added by hand.
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in $allowed) {
    $id = New-Object Security.Principal.SecurityIdentifier $sid
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule $id, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
}
$acl.SetOwner($admins)
Set-Acl -LiteralPath $root -AclObject $acl
# Everything inside inherits the folder's entries only, and Administrators own it.
foreach ($item in Get-ChildItem -LiteralPath $root -Recurse -Force) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "$($item.FullName) is a link. Remove it, then install again." }
    $child = Get-Acl -LiteralPath $item.FullName
    $child.SetAccessRuleProtection($false, $false)
    foreach ($rule in @($child.Access | Where-Object { -not $_.IsInherited })) { [void]$child.RemoveAccessRuleSpecific($rule) }
    $child.SetOwner($admins)
    Set-Acl -LiteralPath $item.FullName -AclObject $child
}
foreach ($item in @(Get-Item -LiteralPath $root -Force) + @(Get-ChildItem -LiteralPath $root -Recurse -Force)) {
    $check = Get-Acl -LiteralPath $item.FullName
    $owner = (New-Object Security.Principal.NTAccount $check.Owner).Translate([Security.Principal.SecurityIdentifier]).Value
    if ($owner -ne $admins.Value) { throw "$($item.FullName) is owned by $($check.Owner)." }
    foreach ($rule in $check.Access) {
        if ($rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowed) { throw "$($item.FullName) still grants $($rule.IdentityReference)." }
    }
}
