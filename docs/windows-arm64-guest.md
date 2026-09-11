# Windows ARM64 guest proof

UTM VM `Codex Grok Windows ARM64` (`4B2C76AC-75D8-4247-BE00-3B60CCFE372D`).
Windows 11 Pro 25H2, `Get-CimInstance Win32_ComputerSystem.SystemType` = **ARM64-based PC**.
No x64/x86 QEMU emulation.

Recorded 2026-09-12. Host gate on this branch is **160/160**. Guest `node --test` on the 1.5.0 tree (`c1661c7`) is **157 pass / 0 fail / 3 skip**; the three skips are Linux-only desktop installer/launcher tests (`sh` is not on this guest).

## Runtime

- Official Node.js **v22.23.2** `win-arm64` zip at `C:\Users\Public\nodejs\node.exe`
- Package extracted from `git archive` of this branch
- `qemu-ga` / `utmctl exec` as `NT AUTHORITY\SYSTEM` (process arch may report `AMD64`; the OS is ARM64)
- Official ChatGPT ARM64 MSIX provisioned: `OpenAI.Codex_26.903.8094.0_arm64__2p2nqsd0c76g0`
  - Installer: `https://persistent.oaistatic.com/codex-app-prod/ChatGPT-arm64.msix`
  - Desktop: `...\app\ChatGPT.exe` (`chatgpt-exists=True`)
  - CLI: `...\app\resources\codex.exe` (`codex-exists=True`) → **`codex-cli 0.153.4`**

Guest probe 2026-09-12 (`C:\Users\Public\v150-fast.txt`):

```
arch-env=AMD64
systemType=ARM64-based PC
chatgpt-exists=True
codex-exists=True
codex-version=codex-cli 0.153.4
grok-version=grok 1.0.25 (f7e67d6988e2)
```

## Isolated installer

`scripts/install-codex-grok-app.ps1` with `LOCALAPPDATA=C:\Users\Public\agent-profile` on the 1.5.0 tree:

```
store pointer store-app.txt=C:\Program Files\WindowsApps\OpenAI.Codex_26.903.8094.0_arm64__2p2nqsd0c76g0\app\ChatGPT.exe
store pointer store-codex.txt=C:\Program Files\WindowsApps\OpenAI.Codex_26.903.8094.0_arm64__2p2nqsd0c76g0\app\resources\codex.exe
win32 wrapper C:\Users\Public\agent-profile\codex-grok-bridge\app\codex-grok-desktop.cmd
bridge in C:\Users\Public\agent-profile\codex-grok-bridge\app matches C:\Users\Public\codex-grok-bridge-150
```

Did not write `WindowsApps` or the stock ChatGPT/Codex prefix.

## Bridge smoke

`createBridgeServer` on loopback:

```
smoke-status=200
smoke-model=grok-4.6
```

Official `install.ps1` then put **Grok 1.0.25** at `C:\Users\Public\grok-home\.grok\bin\grok.exe`. `grok --version` printed `grok 1.0.25 (f7e67d6988e2)`. The installer labeled that build `windows-x86_64` because the qemu-ga PowerShell process reports `AMD64` even though the OS is ARM64. Native `windows-aarch64` was not what this install path fetched.

## Store ChatGPT pointer

`Add-AppxProvisionedPackage -Online` installed the official ARM64 MSIX for all users. `Add-AppxPackage` as `SYSTEM` fails (`0x80073CF9`). The wrapper does not copy out of `WindowsApps`. It reads:

- `%LOCALAPPDATA%\codex-grok-bridge\store-app.txt` → `ChatGPT.exe`
- `%LOCALAPPDATA%\codex-grok-bridge\store-codex.txt` → `resources\codex.exe`

Guest resolve with `LOCALAPPDATA=C:\Users\Public\agent-profile`:

```
desktop=C:\Program Files\WindowsApps\OpenAI.Codex_26.903.8094.0_arm64__2p2nqsd0c76g0\app\ChatGPT.exe
codex=C:\Program Files\WindowsApps\OpenAI.Codex_26.903.8094.0_arm64__2p2nqsd0c76g0\app\resources\codex.exe
```

Package `"os"` is `["darwin","linux","win32"]` starting at **1.5.0**. Do not treat npm 1.0.4/1.0.5 as a Windows install target.

## 1.5.0 guest gate

`git archive` of `c1661c7` extracted to `C:\Users\Public\codex-grok-bridge-150`:

```
# tests 160
# pass 157
# fail 0
# skipped 3
```

User `agent` already sees `Get-AppxPackage OpenAI.Codex` as **Ok**. An extra `Add-AppxPackage -Register` as that user returned `0x80070005` (access denied on the provisioned payload) and is not required for resolve/install.
