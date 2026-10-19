import { useEffect, useRef, useState } from "react";
import type { ScreenInput, ScreenServerMessage } from "@openrmm/shared";
import { api } from "./api.js";

interface ScreenPanelProps {
  deviceId: string;
  deviceName: string;
  onClose: () => void;
}

type ScreenStatus = "connecting" | "running" | "error" | "stopped";

/** KeyboardEvent.code → Windows virtual-key codes (common set). */
const KEY_TO_VK: Record<string, number> = {
  Enter: 0x0d,
  Escape: 0x1b,
  Backspace: 0x08,
  Tab: 0x09,
  Space: 0x20,
  ArrowLeft: 0x25,
  ArrowUp: 0x26,
  ArrowRight: 0x27,
  ArrowDown: 0x28,
  Delete: 0x2e,
  Home: 0x24,
  End: 0x23,
  PageUp: 0x21,
  PageDown: 0x22,
  Insert: 0x2d,
  ShiftLeft: 0x10,
  ShiftRight: 0x10,
  ControlLeft: 0x11,
  ControlRight: 0x11,
  AltLeft: 0x12,
  AltRight: 0x12,
  MetaLeft: 0x5b,
  MetaRight: 0x5c,
  CapsLock: 0x14,
  F1: 0x70,
  F2: 0x71,
  F3: 0x72,
  F4: 0x73,
  F5: 0x74,
  F6: 0x75,
  F7: 0x76,
  F8: 0x77,
  F9: 0x78,
  F10: 0x79,
  F11: 0x7a,
  F12: 0x7b,
};

function codeToVk(code: string): number | null {
  if (KEY_TO_VK[code] !== undefined) return KEY_TO_VK[code];
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
  return null;
}

export default function ScreenPanel({ deviceId, deviceName, onClose }: ScreenPanelProps): React.JSX.Element {
  const wsRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [status, setStatus] = useState<ScreenStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null);
  const [fps, setFps] = useState(0);
  const framesRef = useRef<number[]>([]);
  const draggingRef = useRef<"left" | "right" | null>(null);
  const lastMoveRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    async function connect(): Promise<void> {
      try {
        const { sessionId } = await api.createScreen(deviceId);
        if (cancelled) return;
        sessionRef.current = sessionId;

        const proto = location.protocol === "https:" ? "wss" : "ws";
        const ws = new WebSocket(`${proto}://${location.host}/ws/screen?sessionId=${sessionId}`);
        wsRef.current = ws;

        ws.onmessage = (event) => {
          let msg: ScreenServerMessage;
          try {
            msg = JSON.parse(String(event.data)) as ScreenServerMessage;
          } catch {
            return;
          }
          switch (msg.type) {
            case "started":
              setDims({ width: msg.width, height: msg.height });
              setStatus("running");
              break;
            case "frame":
              setFrameSrc(`data:image/jpeg;base64,${msg.data}`);
              framesRef.current.push(Date.now());
              while (framesRef.current.length > 0 && Date.now() - framesRef.current[0]! > 2000) {
                framesRef.current.shift();
              }
              setFps(framesRef.current.length / 2);
              break;
            case "error":
              setError(msg.message);
              setStatus("error");
              break;
            case "stopped":
              setStatus("stopped");
              break;
          }
        };
        ws.onclose = () => {
          if (!cancelled) setStatus((s) => (s === "connecting" ? "error" : s));
        };
      } catch {
        if (!cancelled) setStatus("error");
      }
    }

    void connect();

    return () => {
      cancelled = true;
      const sessionId = sessionRef.current;
      if (sessionId) {
        void api.endScreen(sessionId).catch(() => undefined);
      }
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  function sendInput(input: ScreenInput): void {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "input", input }));
    }
  }

  function toRemote(clientX: number, clientY: number): { x: number; y: number } | null {
    const img = imgRef.current;
    if (!img || !dims || img.naturalWidth === 0) return null;
    const rect = img.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = ((clientX - rect.left) / rect.width) * dims.width;
    const y = ((clientY - rect.top) / rect.height) * dims.height;
    return {
      x: Math.max(0, Math.min(dims.width, Math.round(x))),
      y: Math.max(0, Math.min(dims.height, Math.round(y))),
    };
  }

  function onMouseDown(e: React.MouseEvent): void {
    const p = toRemote(e.clientX, e.clientY);
    if (!p) return;
    draggingRef.current = e.button === 2 ? "right" : "left";
    sendInput({ kind: "mouse", action: "down", ...p, button: draggingRef.current });
  }

  function onMouseMove(e: React.MouseEvent): void {
    const p = toRemote(e.clientX, e.clientY);
    if (!p) return;
    if (draggingRef.current) {
      sendInput({ kind: "mouse", action: "move", ...p });
    } else if (Date.now() - lastMoveRef.current > 120) {
      lastMoveRef.current = Date.now();
      sendInput({ kind: "mouse", action: "move", ...p });
    }
  }

  function onMouseUp(): void {
    if (!draggingRef.current) return;
    sendInput({ kind: "mouse", action: "up", x: 0, y: 0, button: draggingRef.current });
    draggingRef.current = null;
  }

  function onWheel(e: React.WheelEvent): void {
    sendInput({
      kind: "mouse",
      action: "wheel",
      x: 0,
      y: 0,
      delta: Math.max(-120, Math.min(120, e.deltaY)),
    });
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    const vk = codeToVk(e.code);
    if (vk === null) return;
    e.preventDefault();
    sendInput({ kind: "key", action: "down", vk });
  }

  function onKeyUp(e: React.KeyboardEvent): void {
    const vk = codeToVk(e.code);
    if (vk === null) return;
    e.preventDefault();
    sendInput({ kind: "key", action: "up", vk });
  }

  const statusLabel: Record<ScreenStatus, string> = {
    connecting: "connecting…",
    running: "live",
    error: "error",
    stopped: "session ended",
  };

  return (
    <div className="shell-overlay" onClick={onClose}>
      <div className="screen-modal" onClick={(e) => e.stopPropagation()}>
        <div className="shell-head">
          <span className="shell-title">
            {deviceName} <span className={`dot ${status === "running" ? "online" : "offline"}`} />
          </span>
          <span className={`shell-status ${status === "running" ? "running" : status === "error" ? "error" : ""}`}>
            {statusLabel[status]}
            {status === "running" && dims && ` · ${dims.width}×${dims.height} · ~${fps.toFixed(1)} fps`}
          </span>
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <div
          className="screen-body"
          tabIndex={0}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onContextMenu={(e) => e.preventDefault()}
        >
          {status === "connecting" && <div className="shell-hint">Starting screen capture…</div>}
          {error && (
            <div className="screen-error">
              <p>{error}</p>
            </div>
          )}
          {status === "running" && !frameSrc && (
            <div className="shell-hint">Waiting for first frame…</div>
          )}
          {frameSrc && (
            <img
              ref={imgRef}
              src={frameSrc}
              alt={`${deviceName} screen`}
              draggable={false}
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
              onMouseLeave={onMouseUp}
              onWheel={onWheel}
              className="screen-img"
            />
          )}
        </div>
        <div className="shell-foot">
          <span className="dim">
            Click / drag = mouse · scroll = wheel · type = keyboard (common keys) · right-click works
          </span>
        </div>
      </div>
    </div>
  );
}
