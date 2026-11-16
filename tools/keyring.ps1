param(
  [ValidateSet("read", "write", "delete")]
  [string]$Action = "read",
  [string]$Target = "gemini:antigravity",
  [string]$InFile,
  [string]$OutFile,
  [string]$User = "antigravity"
)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class CredNative2 {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL_READ {
    public uint Flags;
    public uint Type;
    public IntPtr TargetName;
    public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public IntPtr TargetAlias;
    public IntPtr UserName;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL_WRITE {
    public uint Flags;
    public uint Type;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
    [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
    [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
  }

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWrite(ref CREDENTIAL_WRITE credential, uint flags);

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredDelete(string target, uint type, uint flags);

  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr buffer);
}
"@

if ($Action -eq "read") {
  $ptr = [IntPtr]::Zero
  if (-not [CredNative2]::CredRead($Target, 1, 0, [ref]$ptr)) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Write-Error "CredRead failed for '$Target' (win32=$err)"
    exit 1
  }
  $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][CredNative2+CREDENTIAL_READ])
  $bytes = New-Object byte[] $cred.CredentialBlobSize
  [Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $cred.CredentialBlobSize)
  [IO.File]::WriteAllBytes((Join-Path (Get-Location) $OutFile), $bytes)
  Write-Output ("target=" + [Runtime.InteropServices.Marshal]::PtrToStringUni($cred.TargetName))
  Write-Output ("user=" + [Runtime.InteropServices.Marshal]::PtrToStringUni($cred.UserName))
  Write-Output ("blobBytes=" + $cred.CredentialBlobSize)
  [CredNative2]::CredFree($ptr)
  exit 0
}

if ($Action -eq "write") {
  if (-not $InFile) {
    Write-Error "InFile é obrigatório para write"
    exit 1
  }
  $bytes = [IO.File]::ReadAllBytes((Join-Path (Get-Location) $InFile))
  if ($bytes.Length -eq 0) {
    Write-Error "blob vazio"
    exit 1
  }
  $blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
  try {
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
    $cred = New-Object CredNative2+CREDENTIAL_WRITE
    $cred.Flags = 0
    $cred.Type = 1
    $cred.TargetName = $Target
    $cred.Comment = $null
    $cred.CredentialBlobSize = [uint32]$bytes.Length
    $cred.CredentialBlob = $blob
    $cred.Persist = 2
    $cred.AttributeCount = 0
    $cred.Attributes = [IntPtr]::Zero
    $cred.TargetAlias = $null
    $cred.UserName = $User

    if (-not [CredNative2]::CredWrite([ref]$cred, 0)) {
      $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      Write-Error "CredWrite failed for '$Target' (win32=$err)"
      exit 1
    }
    Write-Output ("written=$Target bytes=" + $bytes.Length)
    exit 0
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
  }
}

if ($Action -eq "delete") {
  if (-not [CredNative2]::CredDelete($Target, 1, 0)) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Write-Error "CredDelete failed for '$Target' (win32=$err)"
    exit 1
  }
  Write-Output ("deleted=$Target")
  exit 0
}

Write-Error "Action inválida: $Action"
exit 1
