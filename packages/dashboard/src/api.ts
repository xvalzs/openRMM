/**
 * Thin typed wrapper around the OpenRMM REST API.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { DeviceListResponse, SessionInfo } from "@openrmm/shared";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
  }
  return body as T;
}

export const api = {
  me: () => request<SessionInfo>("/api/auth/me"),
  login: (username: string, password: string) =>
    request<SessionInfo>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  devices: () => request<DeviceListResponse>("/api/devices"),
};
