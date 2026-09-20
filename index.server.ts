import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readConfig } from "./server/config.js";
import { register } from "./server/observer.js";
import { supervisionSettings } from "./shared/supervision.js";

export default function contribute(server: PluginServerContext): () => void {
  // Validate before registering hooks or performing any external work.
  const config = readConfig(process.env);
  server.registerSettings(supervisionSettings);
  return register(server, config);
}
