import type { AppSettings } from "./types.js";

export const DEFAULT_SETTINGS: AppSettings = {
  systemPrompt: "You are a helpful assistant inside a Chrome extension.",
  pageContextMaxChars: 12000,
  local: {
    apiType: "openai-compatible",
    baseUrl: "http://127.0.0.1:8080",
    model: "Gemma4-E2B-it"
  }
};
