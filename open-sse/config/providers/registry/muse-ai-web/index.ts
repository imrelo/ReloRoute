import type { RegistryEntry } from "../../shared.ts";

export const muse_ai_webProvider: RegistryEntry = {
  id: "muse-ai-web",
  alias: "museai",
  format: "openai",
  executor: "muse-ai-web",
  baseUrl: "https://muse.ai",
  authType: "apikey",
  authHeader: "cookie",
  toolCalling: "emulated",
  models: [{ id: "muse-chat", name: "Muse Chat", toolCalling: true }],
};
