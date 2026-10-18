#!/usr/bin/env node
/**
 * OpenRMM agent CLI.
 *
 *   install    --server <url> --key <installKey>   write config
 *   run                                            connect and report forever
 *   uninstall                                      remove local config
 *   version                                        print version
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { agentVersion } from "./inventory.js";
import { agentHome, loadConfig, newClientId, removeConfig, writeConfig } from "./config.js";
import { createAgentClient } from "./client.js";

const USAGE = `
OpenRMM agent

Usage:
  openrmm-agent install --server <url> --key <installKey>
  openrmm-agent run
  openrmm-agent uninstall
  openrmm-agent version

Environment:
  RMM_AGENT_HOME    directory for agent config (default: ~/.openrmm-agent)
  RMM_SERVER_URL    fallback for --server
  RMM_INSTALL_KEY   fallback for --key
`.trim();

interface ParsedArgs {
  command: string;
  options: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const options: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const value = rest[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        options[key] = value;
        i++;
      } else {
        options[key] = "true";
      }
    }
  }
  return { command: command ?? "help", options };
}

function log(msg: string): void {
  console.log(`[openrmm-agent] ${msg}`);
}

function main(): void {
  const { command, options } = parseArgs(process.argv.slice(2));

  switch (command) {
    case "install": {
      const serverUrl = options.server ?? process.env.RMM_SERVER_URL;
      const installKey = options.key ?? process.env.RMM_INSTALL_KEY;
      if (!serverUrl || !installKey) {
        console.error("install requires --server <url> and --key <installKey>\n\n" + USAGE);
        process.exit(1);
      }
      const existing = loadConfig();
      const clientId = existing?.clientId ?? newClientId();
      const config = { serverUrl: serverUrl.replace(/\/+$/, ""), installKey, clientId };
      writeConfig(config);
      log(`installed: clientId=${clientId}`);
      log(`server:   ${config.serverUrl}`);
      log(`config:   ${agentHome()}`);
      log("next step: run the agent with `openrmm-agent run` (see README for running as a service)");
      break;
    }

    case "run": {
      let config;
      try {
        config = loadConfig();
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
      if (!config) {
        console.error("no config found. Run `openrmm-agent install --server <url> --key <key>` first.");
        process.exit(1);
      }
      const client = createAgentClient(config, log);
      process.on("SIGINT", () => client.stop());
      process.on("SIGTERM", () => client.stop());
      void client.run().catch((err: Error) => {
        log(`fatal: ${err.message}`);
        process.exit(1);
      });
      break;
    }

    case "uninstall": {
      removeConfig();
      log(`removed config from ${agentHome()}`);
      break;
    }

    case "version":
    case "--version":
    case "-v": {
      console.log(agentVersion());
      break;
    }

    case "help":
    case "--help":
    case "-h":
    default: {
      console.log(USAGE);
      break;
    }
  }
}

main();
