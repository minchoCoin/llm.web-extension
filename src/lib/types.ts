export type ChatRole = "system" | "user" | "assistant";
export type LocalApiType = "openai-compatible" | "ollama";
export type MessageStatus = "done" | "streaming" | "error";

export interface ImageAttachment {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  status?: MessageStatus;
  attachments?: ImageAttachment[];
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  messages: ChatMessage[];
}

export interface LocalProviderSettings {
  apiType: LocalApiType;
  baseUrl: string;
  model: string;
}

export interface AppSettings {
  systemPrompt: string;
  pageContextMaxChars: number;
  local: LocalProviderSettings;
}

export interface AppState {
  settings: AppSettings;
  sessions: ChatSession[];
  activeSessionId: string;
}

export interface ChatRequestMessage {
  type: "chat:send";
  payload: {
    content: string;
  };
}

export interface GetStateRequestMessage {
  type: "state:get";
}

export interface SaveSettingsRequestMessage {
  type: "settings:save";
  payload: AppSettings;
}

export interface ClearChatRequestMessage {
  type: "chat:clear";
}

export type ExtensionRequestMessage =
  | ChatRequestMessage
  | GetStateRequestMessage
  | SaveSettingsRequestMessage
  | ClearChatRequestMessage;

export interface ExtensionResponseMessage {
  ok: boolean;
  state?: AppState;
  error?: string;
}
