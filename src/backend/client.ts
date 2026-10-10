import { invoke } from "@tauri-apps/api/core";
import type { ImplementedCommands } from "./contracts";

export function call<K extends keyof ImplementedCommands>(
  command: K,
  ...args: keyof ImplementedCommands[K]["args"] extends never
    ? []
    : [ImplementedCommands[K]["args"]]
): Promise<ImplementedCommands[K]["result"]> {
  return invoke(command, args[0]);
}
