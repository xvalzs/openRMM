/**
 * Agent configuration stored on disk.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface AgentConfig {
  serverUrl: string;
  installKey: string;
  clientId: string;
}

/** Directory that holds the agent's config file. */
export function agentHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.RMM_AGENT_HOME
    ? path.resolve(env.RMM_AGENT_HOME)
    : path.join(os.homedir(), ".openrmm-agent");
}

export function configPath(home: string = agentHome()): string {
  return path.join(home, "agent.json");
}

export function loadConfig(home: string = agentHome()): AgentConfig | null {
  const file = configPath(home);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<AgentConfig>;
    if (typeof raw.serverUrl !== "string" || typeof raw.installKey !== "string" || typeof raw.clientId !== "string") {
      throw new Error("config file is missing required fields");
    }
    return { serverUrl: raw.serverUrl, installKey: raw.installKey, clientId: raw.clientId };
  } catch (err) {
    throw new Error(`Failed to read ${file}: ${(err as Error).message}`);
  }
}

export function writeConfig(config: AgentConfig, home: string = agentHome()): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(configPath(home), JSON.stringify(config, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function removeConfig(home: string = agentHome()): void {
  const file = configPath(home);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

export function newClientId(): string {
  return randomUUID();
}
