import { DEFAULT_SETTINGS } from "./defaults.js";
import type { AppSettings, AppState, ChatMessage, ChatSession, ImageAttachment } from "./types.js";

export const APP_STATE_STORAGE_KEY = "appState";

function createSessionTitle(index: number): string {
  return `Session ${index + 1}`;
}

function createEmptySession(index = 0): ChatSession {
  return {
    id: crypto.randomUUID(),
    title: createSessionTitle(index),
    createdAt: new Date().toISOString(),
    messages: []
  };
}

function cloneDefaults(): AppSettings {
  return {
    systemPrompt: DEFAULT_SETTINGS.systemPrompt,
    pageContextMaxChars: DEFAULT_SETTINGS.pageContextMaxChars,
    local: { ...DEFAULT_SETTINGS.local }
  };
}

function sanitizeSettings(input?: Partial<AppSettings>): AppSettings {
  return {
    systemPrompt: input?.systemPrompt ?? DEFAULT_SETTINGS.systemPrompt,
    pageContextMaxChars: Math.max(1000, Math.min(50000, input?.pageContextMaxChars ?? DEFAULT_SETTINGS.pageContextMaxChars)),
    local: {
      apiType: input?.local?.apiType ?? DEFAULT_SETTINGS.local.apiType,
      baseUrl: input?.local?.baseUrl ?? DEFAULT_SETTINGS.local.baseUrl,
      model: input?.local?.model ?? DEFAULT_SETTINGS.local.model
    }
  };
}

function sanitizeMessages(messages: unknown): ChatMessage[] {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages.map((message) => ({
    ...(message as ChatMessage),
    attachments: sanitizeAttachments((message as ChatMessage).attachments)
  }));
}

function sanitizeAttachments(attachments: unknown): ImageAttachment[] {
  return Array.isArray(attachments) ? (attachments as ImageAttachment[]) : [];
}

function sanitizeSessions(input: (Partial<AppState> & { messages?: unknown }) | undefined): ChatSession[] {
  if (Array.isArray(input?.sessions) && input.sessions.length > 0) {
    return input.sessions.map((session, index) => ({
      id: session.id ?? crypto.randomUUID(),
      title: session.title?.trim() || createSessionTitle(index),
      createdAt: session.createdAt ?? new Date().toISOString(),
      messages: sanitizeMessages(session.messages)
    }));
  }

  const legacyMessages = sanitizeMessages(input?.messages);
  const fallbackSession = createEmptySession(0);

  return [
    {
      ...fallbackSession,
      messages: legacyMessages
    }
  ];
}

function sanitizeState(input?: Partial<AppState>): AppState {
  const sessions = sanitizeSessions(input);
  const activeSessionId = sessions.some((session) => session.id === input?.activeSessionId)
    ? (input?.activeSessionId as string)
    : sessions[0].id;

  return {
    settings: sanitizeSettings(input?.settings ?? cloneDefaults()),
    sessions,
    activeSessionId
  };
}

export function getActiveSession(state: AppState): ChatSession {
  return state.sessions.find((session) => session.id === state.activeSessionId) ?? state.sessions[0];
}

function replaceSession(state: AppState, updatedSession: ChatSession): AppState {
  return {
    ...state,
    sessions: state.sessions.map((session) => (session.id === updatedSession.id ? updatedSession : session))
  };
}

export async function readState(): Promise<AppState> {
  const result = await chrome.storage.local.get(APP_STATE_STORAGE_KEY);
  const stored = result[APP_STATE_STORAGE_KEY] as Partial<AppState> | undefined;

  return sanitizeState(stored);
}

export async function writeState(state: AppState): Promise<void> {
  await chrome.storage.local.set({ [APP_STATE_STORAGE_KEY]: state });
}

export async function updateSettings(settings: AppSettings): Promise<AppState> {
  const current = await readState();
  const nextState = sanitizeState({
    ...current,
    settings: sanitizeSettings(settings)
  });

  await writeState(nextState);
  return nextState;
}

export async function createSession(): Promise<AppState> {
  const current = await readState();
  const nextSession = createEmptySession(current.sessions.length);
  const nextState: AppState = {
    ...current,
    sessions: [...current.sessions, nextSession],
    activeSessionId: nextSession.id
  };

  await writeState(nextState);
  return nextState;
}

export async function setActiveSession(sessionId: string): Promise<AppState> {
  const current = await readState();

  if (!current.sessions.some((session) => session.id === sessionId)) {
    return current;
  }

  const nextState: AppState = {
    ...current,
    activeSessionId: sessionId
  };

  await writeState(nextState);
  return nextState;
}

export async function deleteSession(sessionId?: string): Promise<AppState> {
  const current = await readState();
  const targetSessionId = sessionId ?? current.activeSessionId;
  const remainingSessions = current.sessions.filter((session) => session.id !== targetSessionId);
  const sessions = remainingSessions.length > 0 ? remainingSessions : [createEmptySession(0)];
  const nextState: AppState = {
    ...current,
    sessions,
    activeSessionId: sessions[0].id
  };

  await writeState(nextState);
  return nextState;
}

export async function replaceActiveSessionMessages(messages: ChatMessage[]): Promise<AppState> {
  const current = await readState();
  const activeSession = getActiveSession(current);
  const nextState = replaceSession(current, {
    ...activeSession,
    messages
  });

  await writeState(nextState);
  return nextState;
}

export async function clearMessages(): Promise<AppState> {
  return replaceActiveSessionMessages([]);
}
