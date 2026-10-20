/**
 * Thin typed wrapper around the OpenRMM REST API.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type {
  AgentUpdate,
  Alert,
  AlertListResponse,
  AlertRule,
  AlertRuleInput,
  AlertSettings,
  ApiKeyInfo,
  AuditEntry,
  DeviceListResponse,
  DeviceUpdateInfo,
  FileTransferInfo,
  InstallerInfo,
  InstallerTarget,
  JobDetail,
  JobSummary,
  ProcessInfo,
  SessionInfo,
  UpdateDispatchInput,
  UserInfo,
  UserRole,
} from "@openrmm/shared";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  // Only send a content-type when there is a body: Fastify rejects empty
  // bodies with a JSON content-type.
  if (init?.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { ...headers, ...(init?.headers ?? {}) },
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

  // Shell sessions
  createShell: (deviceId: string) =>
    request<{ sessionId: string; shell: string }>(`/api/devices/${deviceId}/shell`, {
      method: "POST",
    }),
  endShell: (sessionId: string) =>
    request<{ ok: true }>(`/api/shells/${sessionId}`, { method: "DELETE" }),

  // Alert rules
  alertRules: () => request<{ rules: AlertRule[] }>("/api/alert-rules"),
  createAlertRule: (input: AlertRuleInput) =>
    request<AlertRule>("/api/alert-rules", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateAlertRule: (id: string, patch: Partial<AlertRuleInput>) =>
    request<AlertRule>(`/api/alert-rules/${id}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  deleteAlertRule: (id: string) =>
    request<{ ok: true }>(`/api/alert-rules/${id}`, { method: "DELETE" }),

  // Alerts
  alerts: (state: "active" | "resolved" | "all") =>
    request<AlertListResponse>(`/api/alerts?state=${state}&limit=100`),

  // Alert settings
  alertSettings: () => request<AlertSettings>("/api/alert-settings"),
  updateAlertSettings: (webhookUrl: string) =>
    request<AlertSettings>("/api/alert-settings", {
      method: "PUT",
      body: JSON.stringify({ webhookUrl }),
    }),

  // Jobs
  jobs: () => request<{ jobs: JobSummary[] }>("/api/jobs"),
  job: (id: string) => request<JobDetail>(`/api/jobs/${id}`),
  createJob: (input: {
    name: string;
    script: string;
    deviceIds?: string[] | null;
    timeoutSec?: number;
  }) =>
    request<JobSummary>("/api/jobs", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  cancelJob: (id: string) =>
    request<{ ok: true }>(`/api/jobs/${id}/cancel`, { method: "POST" }),
  deleteJob: (id: string) =>
    request<{ ok: true }>(`/api/jobs/${id}`, { method: "DELETE" }),

  // Users (admin only)
  users: () => request<{ users: UserInfo[] }>("/api/users"),
  createUser: (input: { username: string; password: string; role: UserRole }) =>
    request<UserInfo>("/api/users", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateUser: (id: number, patch: { password?: string; role?: UserRole }) =>
    request<UserInfo>(`/api/users/${id}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  deleteUser: (id: number) =>
    request<{ ok: true }>(`/api/users/${id}`, { method: "DELETE" }),

  // Updates
  updateInfo: () => request<{ devices: DeviceUpdateInfo[] }>("/api/updates/info"),
  updates: () => request<{ updates: AgentUpdate[] }>("/api/updates"),
  dispatchUpdate: (input: UpdateDispatchInput) =>
    request<{ updates: AgentUpdate[] }>("/api/updates", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  // API keys
  apiKeys: () => request<{ keys: ApiKeyInfo[] }>("/api/api-keys"),
  createApiKey: (name: string) =>
    request<ApiKeyInfo>("/api/api-keys", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  deleteApiKey: (id: string) =>
    request<{ ok: true }>(`/api/api-keys/${id}`, { method: "DELETE" }),

  // Audit
  audit: (limit = 200) => request<{ entries: AuditEntry[] }>(`/api/audit?limit=${limit}`),

  // Files
  transfers: () => request<{ transfers: FileTransferInfo[] }>("/api/files"),
  uploadFile: (deviceId: string, destPath: string, file: File) => {
    const form = new FormData();
    form.append("deviceId", deviceId);
    form.append("destPath", destPath);
    form.append("file", file);
    return fetch("/api/files/upload", {
      method: "POST",
      credentials: "same-origin",
      body: form,
    }).then(async (res) => {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
      return body as unknown as FileTransferInfo;
    });
  },
  downloadFile: (deviceId: string, path: string) =>
    request<FileTransferInfo>("/api/files/download", {
      method: "POST",
      body: JSON.stringify({ deviceId, path }),
    }),
  downloadUrl: (transferId: string) => `/api/files/downloads/${transferId}`,

  // Processes
  processes: (deviceId: string) =>
    request<{ processes: ProcessInfo[]; ts: number }>(`/api/devices/${deviceId}/processes`),
  refreshProcesses: (deviceId: string) =>
    request<{ ok: true }>(`/api/devices/${deviceId}/processes/refresh`, { method: "POST" }),
  killProcess: (deviceId: string, pid: number) =>
    request<{ ok: true }>(`/api/devices/${deviceId}/processes/${pid}/kill`, { method: "POST" }),

  // Screen
  createScreen: (deviceId: string) =>
    request<{ sessionId: string }>(`/api/devices/${deviceId}/screen`, { method: "POST" }),
  endScreen: (sessionId: string) =>
    request<{ ok: true }>(`/api/screens/${sessionId}`, { method: "DELETE" }),

  // Installers
  installers: () => request<{ installers: InstallerInfo[] }>("/api/installers"),
  installerDefaults: () =>
    request<{ serverUrl: string; installKey: string }>("/api/installers/defaults"),
  buildInstaller: (input: {
    name: string;
    target: InstallerTarget;
    serverUrl?: string;
    installKey?: string;
    autoService?: boolean;
  }) =>
    request<InstallerInfo>("/api/installers", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  deleteInstaller: (id: string) =>
    request<{ ok: true }>(`/api/installers/${id}`, { method: "DELETE" }),
  installerDownloadUrl: (id: string) => `/api/installers/${id}/download`,
};
