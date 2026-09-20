import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readConfig } from "./server/config.js";
import { register } from "./server/observer.js";

export default function contribute(server: PluginServerContext): () => void {
  // Validate before registering hooks or performing any external work.
  return register(server, readConfig(process.env));
}
