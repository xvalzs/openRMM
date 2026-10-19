/**
 * Process management service: relays list/kill requests to agents and
 * caches the latest process list per device.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { ProcessInfo, ServerMessage } from "@openrmm/shared";
import type { AgentSockets } from "./routes/agent.js";

function send(socket: ReturnType<AgentSockets["get"]>, msg: ServerMessage): void {
  if (socket && socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

export class ProcessesService {
  private cache = new Map<string, { processes: ProcessInfo[]; ts: number }>();

  constructor(private readonly sockets: AgentSockets) {}

  /** Ask the agent for a fresh process list. */
  refresh(deviceId: string): boolean {
    const socket = this.sockets.get(deviceId);
    if (!socket) return false;
    send(socket, { type: "process_list" });
    return true;
  }

  handleResult(deviceId: string, processes: ProcessInfo[]): void {
    this.cache.set(deviceId, { processes, ts: Date.now() });
  }

  get(deviceId: string): { processes: ProcessInfo[]; ts: number } | null {
    return this.cache.get(deviceId) ?? null;
  }

  kill(deviceId: string, pid: number): boolean {
    const socket = this.sockets.get(deviceId);
    if (!socket) return false;
    send(socket, { type: "process_kill", pid });
    return true;
  }

  onDeviceDisconnected(deviceId: string): void {
    this.cache.delete(deviceId);
  }
}
