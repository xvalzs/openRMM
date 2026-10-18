import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { ShellServerMessage } from "@openrmm/shared";
import { api } from "./api.js";
import "@xterm/xterm/css/xterm.css";

interface ShellPanelProps {
  deviceId: string;
  deviceName: string;
  onClose: () => void;
}

type ShellStatus = "connecting" | "running" | "exited" | "error";

export default function ShellPanel({ deviceId, deviceName, onClose }: ShellPanelProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef<string | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const decoderRef = useRef(new TextDecoder());
  const [status, setStatus] = useState<ShellStatus>("connecting");
  const [exitCode, setExitCode] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function connect(): Promise<void> {
      try {
        const { sessionId } = await api.createShell(deviceId);
        if (cancelled) return;
        sessionRef.current = sessionId;

        const term = new Terminal({
          convertEol: false,
          cursorBlink: true,
          fontSize: 13,
          fontFamily: '"Cascadia Mono", Consolas, monospace',
          scrollback: 5000,
          theme: {
            background: "#0d1117",
            foreground: "#e6edf3",
            cursor: "#2dd4bf",
            selectionBackground: "rgba(45, 212, 191, 0.3)",
          },
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(containerRef.current!);
        fit.fit();
        termRef.current = term;

        const onResize = (): void => {
          try {
            fit.fit();
          } catch {
            /* container not sized yet */
          }
        };
        const observer = new ResizeObserver(onResize);
        observer.observe(containerRef.current!);
        observerRef.current = observer;

        const proto = location.protocol === "https:" ? "wss" : "ws";
        const ws = new WebSocket(`${proto}://${location.host}/ws/shell?sessionId=${sessionId}`);
        wsRef.current = ws;

        ws.onopen = () => term.focus();
        ws.onmessage = (event) => {
          let msg: ShellServerMessage;
          try {
            msg = JSON.parse(String(event.data)) as ShellServerMessage;
          } catch {
            return;
          }
          switch (msg.type) {
            case "started":
              setStatus("running");
              term.focus();
              break;
            case "data":
              term.write(decoderRef.current.decode(
                Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0)),
                { stream: true },
              ));
              break;
            case "exited":
              setExitCode(msg.code);
              setStatus("exited");
              break;
            case "error":
              setStatus("error");
              break;
          }
        };
        ws.onclose = () => {
          setStatus((s) => (s === "connecting" ? "error" : s));
        };

        term.onData((data) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "stdin", data }));
          }
        });
      } catch {
        if (!cancelled) setStatus("error");
      }
    }

    void connect();

    return () => {
      cancelled = true;
      const sessionId = sessionRef.current;
      if (sessionId) {
        void api.endShell(sessionId).catch(() => undefined);
      }
      wsRef.current?.close();
      observerRef.current?.disconnect();
      termRef.current?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  const statusLabel: Record<ShellStatus, string> = {
    connecting: "connecting…",
    running: "connected",
    exited: `exited (code ${exitCode ?? "?"})`,
    error: "failed to start shell",
  };

  return (
    <div className="shell-overlay" onClick={onClose}>
      <div className="shell-modal" onClick={(e) => e.stopPropagation()}>
        <div className="shell-head">
          <span className="shell-title">
            {deviceName} <span className={`dot ${status === "running" ? "online" : "offline"}`} />
          </span>
          <span className={`shell-status ${status}`}>{statusLabel[status]}</span>
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="shell-body">
          {status === "connecting" && <div className="shell-hint">Starting shell…</div>}
          <div className="shell-term" ref={containerRef} />
        </div>
        {status === "exited" && (
          <div className="shell-foot">
            <button className="ghost" onClick={onClose}>
              Close terminal
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
