# Windows ARM64 guest proof

UTM VM `Codex Grok Windows ARM64` (`4B2C76AC-75D8-4247-BE00-3B60CCFE372D`).
Windows 11 Pro 25H2, `Get-CimInstance Win32_ComputerSystem.SystemType` = **ARM64-based PC**.
No x64/x86 QEMU emulation.

Recorded 2026-09-12 on commit `4a69481`.

## Runtime

- Official Node.js **v22.23.2** `win-arm64` zip at `C:\Users\Public\nodejs\node.exe`
- Package extracted from `git archive` of this branch
- `qemu-ga` / `utmctl exec` as `NT AUTHORITY\SYSTEM` (process arch may report `AMD64`; the OS is ARM64)

## `node --test`

```
# tests 159
# pass 156
# fail 0
# skipped 3
# duration_ms 4730.256667
```

The three skips are Linux-only desktop installer/launcher tests (`sh` is not on this guest).

## Isolated installer

`scripts/install-codex-grok-app.ps1` with `LOCALAPPDATA=C:\Users\Public\agent-profile`:

```
win32 wrapper C:\Users\Public\agent-profile\codex-grok-bridge\app\codex-grok-desktop.cmd
bridge in C:\Users\Public\agent-profile\codex-grok-bridge\app matches C:\Users\Public\codex-grok-bridge
launcher=OK
startmenu=OK
```

Did not write `WindowsApps` or the stock ChatGPT/Codex prefix.

## Bridge smoke

`createBridgeServer` on loopback:

```
smoke-status=200
smoke-model=grok-4.6
```

ChatGPT/Codex desktop and `grok.exe` are not on this guest yet, so `launch-desktop` cannot open a real window. npm `"os"` still omits `win32` until that desktop binary exists.
