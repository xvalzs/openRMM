/**
 * Agent update deployment: dispatch a new agent bundle (URL + SHA-256) to
 * targeted devices. The agent downloads, verifies, self-replaces, and
 * restarts; completion is confirmed when the device reconnects.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { randomUUID } from "node:crypto";
import type {
  AgentUpdate,
  ServerMessage,
  UpdateDispatchInput,
  UpdateStatus,
} from "@openrmm/shared";
import type { Store } from "./db.js";
import type { AgentSockets } from "./routes/agent.js";

function send(socket: ReturnType<AgentSockets["get"]>, msg: ServerMessage): void {
  if (socket && socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

export class UpdatesService {
  constructor(
    private readonly store: Store,
    private readonly sockets: AgentSockets,
  ) {}

  dispatch(input: UpdateDispatchInput): AgentUpdate[] {
    const targets =
      input.deviceIds && input.deviceIds.length > 0
        ? input.deviceIds
        : this.store
            .listDevices()
            .filter((d) => d.online)
            .map((d) => d.id);

    const dispatched: AgentUpdate[] = [];
    for (const deviceId of new Set(targets)) {
      const device = this.store.getDevice(deviceId);
      if (!device) continue;

      const id = randomUUID();
      if (this.store.findInFlightUpdate(deviceId)) {
        this.store.createAgentUpdate(id, deviceId, input.url, input.sha256, device.agentVersion);
        this.store.setAgentUpdateStatus(id, "failed", "another update is already in progress");
      } else {
        this.store.createAgentUpdate(id, deviceId, input.url, input.sha256, device.agentVersion);
        if (!device.online || !this.sockets.get(deviceId)) {
          this.store.setAgentUpdateStatus(id, "failed", "device offline");
        } else {
          send(this.sockets.get(deviceId), {
            type: "update_run",
            updateId: id,
            url: input.url,
            sha256: input.sha256,
          });
        }
      }
      dispatched.push(this.store.getAgentUpdate(id)!);
    }
    return dispatched;
  }

  /** Heartbeat-adjacent update info from the agent. */
  handleUpdateInfo(
    deviceId: string,
    pendingUpdates: number | null,
    checkedAt: number,
  ): void {
    this.store.setDeviceUpdateInfo(deviceId, pendingUpdates, checkedAt);
  }

  /** Progress reports from the agent while applying an update. */
  handleUpdateStatus(
    deviceId: string,
    updateId: string,
    status: UpdateStatus,
    error?: string,
  ): void {
    const update = this.store.getAgentUpdate(updateId);
    if (!update || update.deviceId !== deviceId) return;
    this.store.setAgentUpdateStatus(updateId, status, error);
  }

  /** Called when a device registers/connects: complete or resume updates. */
  onDeviceReconnect(deviceId: string, agentVersion: string): void {
    const inFlight = this.store.findInFlightUpdate(deviceId);
    if (!inFlight) return;
    const update = this.store.getAgentUpdate(inFlight.id);
    if (!update) return;

    if (update.status === "restarting") {
      // The agent restarted after replacing itself: done.
      this.store.markAgentUpdateCompleted(inFlight.id, agentVersion);
      return;
    }
    // pending/downloading/verifying: the agent dropped before finishing.
    // Re-send the update command (idempotent).
    const socket = this.sockets.get(deviceId);
    if (socket) {
      send(socket, {
        type: "update_run",
        updateId: update.id,
        url: update.url,
        sha256: update.sha256,
      });
    }
  }
}
