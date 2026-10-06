import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Owner-only file and directory privacy, proven from the actual permissions. */
export class FilePrivacyError extends Error {
  readonly code = "FILE_NOT_PRIVATE";
  constructor(
    readonly path: string,
    readonly reasons: readonly string[]
  ) {
    super(
      `${path} is not private to the current user (${reasons.join("; ")}). ` +
        "Keep the identity: restore permissions so only you can access it, then rotate " +
        "its credentials because they may have been exposed. Do not delete it; a new " +
        "identity would orphan everything owned by the current one."
    );
  }
}

const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";
/** FileSystemRights.FullControl. */
const FULL_CONTROL = 0x1f01ff;

export interface WindowsAcl {
  ownerSid: string;
  currentUserSid: string;
  protected: boolean;
  rules: readonly { sid: string; type: "Allow" | "Deny"; rights: number; inherited: boolean }[];
}

/**
 * Passes only when the owner is the current user, inheritance is off, no rule is
 * inherited, every Allow rule names the current user, SYSTEM or Administrators, and
 * the current user has full control. Deny rules only narrow access and are allowed.
 */
export function evaluateWindowsAcl(acl: WindowsAcl): string[] {
  const reasons: string[] = [];
  const allowed = new Set([acl.currentUserSid, SYSTEM_SID, ADMINISTRATORS_SID]);
  if (acl.ownerSid !== acl.currentUserSid) reasons.push(`owner is ${acl.ownerSid}`);
  if (!acl.protected) reasons.push("inherits permissions from its parent");
  for (const rule of acl.rules) {
    if (rule.inherited) reasons.push(`inherited rule for ${rule.sid}`);
    if (rule.type === "Allow" && !allowed.has(rule.sid))
      reasons.push(`access granted to ${rule.sid}`);
  }
  const own = acl.rules.filter((r) => r.sid === acl.currentUserSid && r.type === "Allow");
  if (!own.some((r) => (r.rights & FULL_CONTROL) === FULL_CONTROL))
    reasons.push("current user lacks full control");
  return reasons;
}

export interface PosixStat {
  uid: number;
  mode: number;
}

export function evaluatePosixMode(stat: PosixStat, currentUid: number): string[] {
  const reasons: string[] = [];
  if (stat.uid !== currentUid) reasons.push(`owned by uid ${stat.uid}`);
  if ((stat.mode & 0o077) !== 0)
    reasons.push(`mode ${(stat.mode & 0o777).toString(8)} grants group or other access`);
  return reasons;
}

// SIDs only: names such as "Everyone" are localized, so they are never parsed.
// Only the Access and Owner sections are read and written: touching the audit
// section (SACL) would need SeSecurityPrivilege, which an ordinary user lacks.
const SECTIONS = "[System.Security.AccessControl.AccessControlSections]'Access,Owner'";
const READ_ACL = `
$a = (Get-Item -LiteralPath $env:CA_PRIVACY_PATH -Force).GetAccessControl(${SECTIONS})
[pscustomobject]@{
  ownerSid = $a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  protected = $a.AreAccessRulesProtected
  rules = @($a.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
    [pscustomobject]@{ sid = $_.IdentityReference.Value; type = "$($_.AccessControlType)"; rights = [int]$_.FileSystemRights; inherited = $_.IsInherited }
  })
} | ConvertTo-Json -Depth 4 -Compress`;

// Removes inherited and explicit rules, then grants only the allowlist; directories
// pass the same rules to new children so a file created inside starts private.
const PROTECT = `
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$item = Get-Item -LiteralPath $env:CA_PRIVACY_PATH -Force
$a = $item.GetAccessControl(${SECTIONS})
$a.SetAccessRuleProtection($true, $false)
foreach ($r in @($a.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))) { [void]$a.RemoveAccessRuleSpecific($r) }
$inherit = if ($env:CA_PRIVACY_KIND -eq 'directory') { [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [System.Security.AccessControl.InheritanceFlags]'None' }
foreach ($sid in @($me.Value, '${SYSTEM_SID}', '${ADMINISTRATORS_SID}')) {
  $a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', $inherit, 'None', 'Allow'))
}
$a.SetOwner($me)
$item.SetAccessControl($a)`;

async function powershell(script: string, env: Record<string, string>) {
  // The path travels in the environment, never interpolated into the script.
  const { stdout } = await run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { env: { ...process.env, ...env }, windowsHide: true, timeout: 30_000 }
  );
  return stdout;
}

export async function readWindowsAcl(path: string): Promise<WindowsAcl> {
  const raw = JSON.parse(await powershell(READ_ACL, { CA_PRIVACY_PATH: path }));
  return { ...raw, rules: Array.isArray(raw.rules) ? raw.rules : raw.rules ? [raw.rules] : [] };
}

/** Rejects links and anything that is not exactly the expected kind at the resolved path. */
async function assertPlainEntry(path: string, kind: "directory" | "file") {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new FilePrivacyError(path, ["is a symbolic link or junction"]);
  if (kind === "directory" ? !info.isDirectory() : !info.isFile())
    throw new FilePrivacyError(path, [`is not a ${kind}`]);
  const real = await realpath(path);
  const same =
    process.platform === "win32"
      ? real.toLowerCase() === resolve(path).toLowerCase()
      : real === resolve(path);
  if (!same) throw new FilePrivacyError(path, [`resolves elsewhere (${real})`]);
  return info;
}

/** Throws FilePrivacyError unless the entry is private to the current user. */
export async function verifyPrivate(path: string, kind: "directory" | "file") {
  const info = await assertPlainEntry(path, kind);
  const reasons =
    process.platform === "win32"
      ? evaluateWindowsAcl(await readWindowsAcl(path))
      : evaluatePosixMode({ uid: info.uid, mode: info.mode }, process.getuid!());
  if (reasons.length) throw new FilePrivacyError(path, reasons);
}

/** Restricts the entry to the current user, then proves it by reading the permissions back. */
export async function makePrivate(path: string, kind: "directory" | "file") {
  await assertPlainEntry(path, kind);
  if (process.platform === "win32")
    await powershell(PROTECT, { CA_PRIVACY_PATH: path, CA_PRIVACY_KIND: kind });
  else {
    const { chmod } = await import("node:fs/promises");
    await chmod(path, kind === "directory" ? 0o700 : 0o600);
  }
  await verifyPrivate(path, kind);
}
