import type { AppSettings, ChatMessage } from "../types.js";

export interface ProviderResult {
  text: string;
}

export interface ProviderStreamInput {
  settings: AppSettings;
  messages: ChatMessage[];
  onToken?: (chunk: string, fullText: string) => void;
}

export interface ChatProvider {
  sendMessage(input: ProviderStreamInput): Promise<ProviderResult>;
  streamMessage(input: ProviderStreamInput): Promise<ProviderResult>;
}
