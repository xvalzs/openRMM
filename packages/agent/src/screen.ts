/**
 * Agent-side remote desktop: screen capture and input injection.
 *
 * Windows: GDI capture via a persistent PowerShell process (CopyFromScreen →
 * JPEG, virtual screen, optional scaling) and input via user32 P/Invoke.
 * macOS: `screencapture` CLI for viewing; input injection not supported yet.
 *
 * Capture works when the agent runs in the interactive user session.
 * A black frame (service session or locked screen) is detected and reported.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { AgentMessage, ScreenInput, ServerMessage } from "@openrmm/shared";

export interface ScreenManager {
  handle(msg: ServerMessage): void;
  closeAll(): void;
}

interface ScreenSession {
  captureProc: ChildProcess | null;
  inputProc: ChildProcess | null;
  width: number;
  height: number;
  scale: number;
  stopped: boolean;
  frameBusy: boolean;
  blackCount: number;
  stdoutBuf: string;
  seq: number;
  pumpTimer: ReturnType<typeof setInterval> | null;
  macTimer: ReturnType<typeof setInterval> | null;
  firstFrameTime: number;
}

const FRAME_DELAY_MS = 60;
const BLACK_THRESHOLD = 2;
const START_TIMEOUT_MS = 15_000;

export function createScreenManager(
  send: (msg: AgentMessage) => void,
  log: (msg: string) => void,
): ScreenManager {
  const sessions = new Map<string, ScreenSession>();

  function handle(msg: ServerMessage): void {
    switch (msg.type) {
      case "screen_start":
        start(msg.sessionId, msg.scale);
        break;
      case "screen_stop":
        stop(msg.sessionId);
        break;
      case "screen_input":
        input(msg.sessionId, msg.input);
        break;
      default:
        break;
    }
  }

  function start(sessionId: string, scale: number): void {
    stop(sessionId);
    if (process.platform === "darwin") {
      startMac(sessions, send, stop, sessionId, scale);
      return;
    }
    if (process.platform !== "win32") {
      send({ type: "screen_error", sessionId, error: "screen view is not supported on this platform" });
      return;
    }
    const s: ScreenSession = {
      captureProc: spawnCapture(scale),
      inputProc: spawnInput(),
      width: 0,
      height: 0,
      scale,
      stopped: false,
      frameBusy: false,
      blackCount: 0,
      stdoutBuf: "",
      seq: 0,
      pumpTimer: null,
      macTimer: null,
      firstFrameTime: 0,
    };
    sessions.set(sessionId, s);

    s.captureProc!.stdout?.on("data", (d: Buffer) => {
      s.stdoutBuf += d.toString("utf8");
      let idx: number;
      while ((idx = s.stdoutBuf.indexOf("\n")) >= 0) {
        const line = s.stdoutBuf.slice(0, idx).replace(/\r$/, "");
        s.stdoutBuf = s.stdoutBuf.slice(idx + 1);
        if (!s.stopped) onCaptureLine(sessionId, s, line);
      }
    });
    s.captureProc!.on("exit", () => {
      if (!s.stopped) {
        send({ type: "screen_stopped", sessionId });
        sessions.delete(sessionId);
      }
    });
    s.inputProc?.on("exit", () => {
      if (!s.stopped && s.inputProc) s.inputProc = null;
    });

    // READY timeout
    setTimeout(() => {
      if (!s.stopped && s.width === 0) {
        send({
          type: "screen_error",
          sessionId,
          error: "failed to initialize screen capture",
        });
        stop(sessionId);
      }
    }, START_TIMEOUT_MS);
  }

  function onCaptureLine(sessionId: string, s: ScreenSession, line: string): void {
    if (line.startsWith("READY ")) {
      const parts = line.split(" ");
      s.width = Number(parts[1]);
      s.height = Number(parts[2]);
      send({ type: "screen_started", sessionId, width: s.width, height: s.height });
      s.pumpTimer = setInterval(() => pump(sessionId, s), 200);
      pump(sessionId, s);
      return;
    }
    if (line === "BLACK") {
      s.frameBusy = false;
      s.blackCount++;
      if (s.blackCount >= BLACK_THRESHOLD) {
        send({
          type: "screen_error",
          sessionId,
          error:
            "screen appears black — the agent may be running as a service " +
            "(session 0) or the console is locked. Run the agent in the " +
            "interactive user session for screen control.",
        });
        stop(sessionId);
        return;
      }
      return;
    }
    if (line.startsWith("ERR ")) {
      send({ type: "screen_error", sessionId, error: line.slice(4) });
      stop(sessionId);
      return;
    }
    // A JPEG frame (base64).
    if (line.length > 100) {
      s.frameBusy = false;
      s.blackCount = 0;
      s.firstFrameTime = Date.now();
      s.seq++;
      send({ type: "screen_frame", sessionId, seq: s.seq, data: line });
    }
  }

function pump(sessionId: string, s: ScreenSession): void {
    if (s.stopped || s.frameBusy || s.width === 0) return;
    s.frameBusy = true;
    try {
      s.captureProc?.stdin?.write("cap\n");
    } catch {
      s.frameBusy = false;
    }
  }

  function input(sessionId: string, input: ScreenInput): void {
    const s = sessions.get(sessionId);
    if (!s || s.stopped) return;
    if (!s.inputProc) {
      send({
        type: "screen_error",
        sessionId,
        error: "input injection is not supported on this platform yet",
      });
      return;
    }
    const lines = inputToCommands(input);
    for (const line of lines) {
      try {
        s.inputProc.stdin?.write(line + "\n");
      } catch {
        break;
      }
    }
  }

  function stop(sessionId: string): void {
    const s = sessions.get(sessionId);
    if (!s) return;
    s.stopped = true;
    if (s.pumpTimer) clearInterval(s.pumpTimer);
    if (s.macTimer) clearInterval(s.macTimer);
    try {
      s.captureProc?.stdin?.write("quit\n");
    } catch {
      /* ignore */
    }
    try {
      s.inputProc?.stdin?.write("quit\n");
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      s.captureProc?.kill();
      s.inputProc?.kill();
    }, 1500).unref();
    sessions.delete(sessionId);
  }

  return {
    handle,
    closeAll: () => {
      for (const sessionId of [...sessions.keys()]) stop(sessionId);
    },
  };
}

function spawnCapture(scale: number): ChildProcess {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$tw = [int]($b.Width * ${scale})
$th = [int]($b.Height * ${scale})
$tbmp = New-Object System.Drawing.Bitmap $tw, $th
$tg = [System.Drawing.Graphics]::FromImage($tbmp)
$tg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$ms = New-Object System.IO.MemoryStream
Write-Output ("READY {0} {1}" -f $tw, $th)
[Console]::Out.Flush()
while ($true) {
  $cmd = [Console]::In.ReadLine()
  if ($null -eq $cmd -or $cmd -eq 'quit') { break }
  if ($cmd -eq 'cap') {
    try {
      $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
      $tg.DrawImage($bmp, 0, 0, $tw, $th)
      $p1 = $bmp.GetPixel(0, 0)
      $p2 = $bmp.GetPixel([int]($b.Width / 2), [int]($b.Height / 2))
      $p3 = $bmp.GetPixel($b.Width - 1, 0)
      $p4 = $bmp.GetPixel(0, $b.Height - 1)
      $p5 = $bmp.GetPixel($b.Width - 1, $b.Height - 1)
      if ($p1.R -eq 0 -and $p1.G -eq 0 -and $p1.B -eq 0 -and $p2.R -eq 0 -and $p2.G -eq 0 -and $p2.B -eq 0 -and $p3.R -eq 0 -and $p3.G -eq 0 -and $p3.B -eq 0 -and $p4.R -eq 0 -and $p4.G -eq 0 -and $p4.B -eq 0 -and $p5.R -eq 0 -and $p5.G -eq 0 -and $p5.B -eq 0) {
        Write-Output 'BLACK'
      } else {
        $ms.SetLength(0)
        $tbmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg)
        Write-Output ([Convert]::ToBase64String($ms.ToArray()))
      }
      [Console]::Out.Flush()
    } catch {
      Write-Output ("ERR " + $_.Exception.Message)
      [Console]::Out.Flush()
      break
    }
  }
}
`;
  return spawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
}

function spawnMacCapture(): ChildProcess {
  // Per-frame invocation; see pump path below (mac path uses spawn per cap).
  throw new Error("mac capture handled separately");
}

/** macOS: `screencapture` per frame; input injection not supported yet. */
function startMac(
  sessions: Map<string, ScreenSession>,
  send: (msg: AgentMessage) => void,
  stopSession: (sessionId: string) => void,
  sessionId: string,
  _scale: number,
): void {
  const s: ScreenSession = {
    captureProc: null,
    inputProc: null,
    width: 0,
    height: 0,
    scale: _scale,
    stopped: false,
    frameBusy: false,
    blackCount: 0,
    stdoutBuf: "",
    seq: 0,
    pumpTimer: null,
    macTimer: null,
    firstFrameTime: 0,
  };
  sessions.set(sessionId, s);

  execFile(
    "osascript",
    ["-e", 'tell application "Finder" to get bounds of window of desktop'],
    { timeout: 10_000 },
    (err, stdout) => {
      if (s.stopped || !sessions.has(sessionId)) return;
      if (err) {
        send({ type: "screen_error", sessionId, error: "failed to query screen size" });
        stopSession(sessionId);
        return;
      }
      const parts = stdout.trim().split(",").map(Number);
      if (parts.length !== 4 || !parts.every(Number.isFinite)) {
        send({ type: "screen_error", sessionId, error: "unexpected screen bounds" });
        stopSession(sessionId);
        return;
      }
      const width = Math.round(parts[2]! - parts[0]!);
      const height = Math.round(parts[3]! - parts[1]!);
      s.width = width;
      s.height = height;
      send({ type: "screen_started", sessionId, width, height });

      const macPump = (): void => {
        if (s.stopped || s.frameBusy || !sessions.has(sessionId)) return;
        s.frameBusy = true;
        execFile(
          "screencapture",
          ["-x", "-t", "jpg", "-"],
          { maxBuffer: 32 * 1024 * 1024, timeout: 15_000, encoding: "buffer" },
          (capErr, out) => {
            s.frameBusy = false;
            if (s.stopped || !sessions.has(sessionId)) return;
            if (capErr) {
              send({
                type: "screen_error",
                sessionId,
                error: `capture failed (grant Screen Recording permission): ${capErr.message}`,
              });
              return;
            }
            s.seq++;
            send({ type: "screen_frame", sessionId, seq: s.seq, data: out.toString("base64") });
          },
        );
      };
      s.macTimer = setInterval(macPump, 300);
      macPump();
    },
  );
}

function spawnInput(): ChildProcess {
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class OpenRMMInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  public struct POINT { public int X; public int Y; }
}
"@
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or $line -eq 'quit') { break }
  $parts = $line -split ' '
  try {
    switch ($parts[0]) {
      'm'  { [OpenRMMInput]::SetCursorPos([int]$parts[1], [int]$parts[2]) | Out-Null }
      'ld' { [OpenRMMInput]::SetCursorPos([int]$parts[1], [int]$parts[2]) | Out-Null; [OpenRMMInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero) }
      'lu' { [OpenRMMInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero) }
      'rd' { [OpenRMMInput]::SetCursorPos([int]$parts[1], [int]$parts[2]) | Out-Null; [OpenRMMInput]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero) }
      'ru' { [OpenRMMInput]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero) }
      'w'  { [OpenRMMInput]::mouse_event(0x0800, 0, 0, [int]$parts[1], [UIntPtr]::Zero) }
      'kd' { [OpenRMMInput]::keybd_event([byte][int]$parts[1], 0, 0, [UIntPtr]::Zero) }
      'ku' { [OpenRMMInput]::keybd_event([byte][int]$parts[1], 0, 2, [UIntPtr]::Zero) }
      'gp' { $p = New-Object OpenRMMInput+POINT; [OpenRMMInput]::GetCursorPos([ref]$p) | Out-Null; Write-Output ("POS {0} {1}" -f $p.X, $p.Y) }
    }
  } catch {
    Write-Output ("ERR " + $_.Exception.Message)
  }
  [Console]::Out.Flush()
}
`;
  return spawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
}

/** Map a ScreenInput to command lines for the input process. */
function inputToCommands(input: ScreenInput): string[] {
  switch (input.kind) {
    case "mouse":
      switch (input.action) {
        case "move":
          return [`m ${Math.round(input.x)} ${Math.round(input.y)}`];
        case "down":
          return [
            `${input.button === "left" ? "ld" : "rd"} ${Math.round(input.x)} ${Math.round(input.y)}`,
          ];
        case "up":
          return [input.button === "left" ? "lu" : "ru"];
        case "wheel":
          return [`w ${Math.round(input.delta)}`];
      }
      return [];
    case "key":
      return [`${input.action === "down" ? "kd" : "ku"} ${input.vk}`];
    case "text":
      return textToKeyCommands(input.text);
  }
}

/** ASCII text → keybd_event sequences (letters, digits, common symbols). */
function textToKeyCommands(text: string): string[] {
  const out: string[] = [];
  const shiftChars: Record<string, string> = {
    "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7",
    "*": "8", "(": "9", ")": "0", "_": "-", "+": "=", "{": "[", "}": "]",
    "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/", "~": "`",
  };
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    let vk = 0;
    let shift = false;
    if (ch >= "a" && ch <= "z") vk = ch.toUpperCase().charCodeAt(0);
    else if (ch >= "A" && ch <= "Z") {
      vk = code;
      shift = true;
    } else if (ch >= "0" && ch <= "9") vk = code;
    else if (ch === " ") vk = 0x20;
    else if (ch === "\n" || ch === "\r") vk = 0x0d;
    else if (ch === "\t") vk = 0x09;
    else if (ch === ".") vk = 0xbe;
    else if (ch === ",") vk = 0xbc;
    else if (ch === "-") vk = 0xbd;
    else if (ch === "=") vk = 0xbb;
    else if (ch === ";") vk = 0xba;
    else if (ch === "/") vk = 0xbf;
    else if (ch === "`") vk = 0xc0;
    else if (ch === "[") vk = 0xdb;
    else if (ch === "\\") vk = 0xdc;
    else if (ch === "]") vk = 0xdd;
    else if (ch === "'") vk = 0xde;
    else if (shiftChars[ch]) {
      vk = shiftChars[ch]!.charCodeAt(0);
      shift = true;
    } else continue;
    if (shift) out.push("kd 16");
    out.push(`kd ${vk}`, `ku ${vk}`);
    if (shift) out.push("ku 16");
  }
  return out;
}
