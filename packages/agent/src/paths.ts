/**
 * Resolves the path of the running agent entry point.
 *
 * Works in three build modes:
 *  - repo build (ESM, dist/):        import.meta.url → dist/index.js
 *  - packaged bundle (ESM, release/): import.meta.url → openrmm-agent.js
 *  - SEA executable (CJS, *.exe):    __filename → the exe itself
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { fileURLToPath } from "node:url";

declare const __filename: string | undefined;

export function getSelfPath(): string {
  if (typeof __filename === "string" && __filename.length > 0) {
    return __filename;
  }
  return fileURLToPath(import.meta.url);
}
