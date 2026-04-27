import { defaultProvider } from "./lib/providers/index.js";
import {
  APP_STATE_STORAGE_KEY,
  clearMessages,
  createSession,
  deleteSession,
  getActiveSession,
  readState,
  setActiveSession,
  updateSettings,
  writeState
} from "./lib/storage.js";
import type { AppSettings, AppState, ChatMessage, ChatSession, ImageAttachment } from "./lib/types.js";

declare global {
  interface Window {
    marked?: {
      parse: (markdown: string) => string;
      setOptions?: (options: Record<string, unknown>) => void;
    };
    renderMathInElement?: (
      element: HTMLElement,
      options?: {
        delimiters?: Array<{
          left: string;
          right: string;
          display: boolean;
        }>;
        throwOnError?: boolean;
      }
    ) => void;
  }
}

const elements = {
  toggleSettingsButton: document.querySelector<HTMLButtonElement>("#toggle-settings-button"),
  settingsContent: document.querySelector<HTMLElement>("#settings-content"),
  systemPromptInput: document.querySelector<HTMLTextAreaElement>("#system-prompt-input"),
  apiTypeSelect: document.querySelector<HTMLSelectElement>("#api-type-select"),
  localBaseUrlInput: document.querySelector<HTMLInputElement>("#local-base-url-input"),
  localModelInput: document.querySelector<HTMLInputElement>("#local-model-input"),
  pageContextMaxCharsInput: document.querySelector<HTMLInputElement>("#page-context-max-chars-input"),
  saveSettingsButton: document.querySelector<HTMLButtonElement>("#save-settings-button"),
  sessionSelect: document.querySelector<HTMLSelectElement>("#session-select"),
  newSessionButton: document.querySelector<HTMLButtonElement>("#new-session-button"),
  deleteSessionButton: document.querySelector<HTMLButtonElement>("#delete-session-button"),
  chatList: document.querySelector<HTMLElement>("#chat-list"),
  messageInput: document.querySelector<HTMLTextAreaElement>("#message-input"),
  imageInput: document.querySelector<HTMLInputElement>("#image-input"),
  attachImageButton: document.querySelector<HTMLButtonElement>("#attach-image-button"),
  pageContextToggle: document.querySelector<HTMLInputElement>("#page-context-toggle"),
  selectedTextOnlyToggle: document.querySelector<HTMLInputElement>("#selected-text-only-toggle"),
  attachmentPreviewList: document.querySelector<HTMLElement>("#attachment-preview-list"),
  sendButton: document.querySelector<HTMLButtonElement>("#send-button"),
  statusText: document.querySelector<HTMLElement>("#status-text"),
  clearChatButton: document.querySelector<HTMLButtonElement>("#clear-chat-button")
};

let appState: AppState | null = null;
let pending = false;
let settingsOpen = false;
let pendingAttachments: ImageAttachment[] = [];
let usePageContext = false;
let useSelectedTextOnly = true;
let pageContextAvailable = true;

const MAX_ATTACHMENTS = 3;
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;

window.marked?.setOptions?.({
  gfm: true,
  breaks: true
});

function assertElement<T>(value: T | null, name: string): T {
  if (!value) {
    throw new Error(`Missing required element: ${name}`);
  }

  return value;
}

function setStatus(text: string): void {
  assertElement(elements.statusText, "statusText").textContent = text;
}

function setPendingState(nextPending: boolean): void {
  pending = nextPending;

  assertElement(elements.sendButton, "sendButton").disabled = nextPending;
  assertElement(elements.saveSettingsButton, "saveSettingsButton").disabled = nextPending;
  assertElement(elements.clearChatButton, "clearChatButton").disabled = nextPending;
  assertElement(elements.newSessionButton, "newSessionButton").disabled = nextPending;
  assertElement(elements.deleteSessionButton, "deleteSessionButton").disabled = nextPending;
  assertElement(elements.sessionSelect, "sessionSelect").disabled = nextPending;
  assertElement(elements.attachImageButton, "attachImageButton").disabled = nextPending;
}

function renderSettingsVisibility(): void {
  const settingsContent = assertElement(elements.settingsContent, "settingsContent");
  const toggleSettingsButton = assertElement(elements.toggleSettingsButton, "toggleSettingsButton");

  settingsContent.classList.toggle("hidden", !settingsOpen);
  toggleSettingsButton.setAttribute("aria-expanded", String(settingsOpen));
  toggleSettingsButton.textContent = settingsOpen ? "Hide" : "Show";
}

function toPermissionPattern(baseUrl: string): string {
  const url = new URL(baseUrl);
  return `${url.protocol}//${url.host}/*`;
}

async function ensureHostPermission(baseUrl: string): Promise<void> {
  const pattern = toPermissionPattern(baseUrl);
  const alreadyGranted = await chrome.permissions.contains({
    origins: [pattern]
  });

  if (alreadyGranted) {
    return;
  }

  const granted = await chrome.permissions.request({
    origins: [pattern]
  });

  if (!granted) {
    throw new Error(`Host permission was not granted for ${pattern}`);
  }
}

function createMessage(role: ChatMessage["role"], content: string, status: ChatMessage["status"] = "done"): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
    status
  };
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderRichText(container: HTMLElement, text: string): void {
  if (!text) {
    container.textContent = "";
    return;
  }

  const safeMarkdown = escapeHtml(text);

  if (window.marked?.parse) {
    container.innerHTML = window.marked.parse(safeMarkdown);
  } else {
    container.textContent = text;
    return;
  }

  window.renderMathInElement?.(container, {
    throwOnError: false,
    delimiters: [
      { left: "$$", right: "$$", display: true },
      { left: "\\[", right: "\\]", display: true },
      { left: "$", right: "$", display: false },
      { left: "\\(", right: "\\)", display: false }
    ]
  });
}

function formatFileSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sessionLabel(session: ChatSession): string {
  const preview = session.messages.find((message) => message.role === "user")?.content.trim();

  if (preview) {
    return preview.slice(0, 32);
  }

  const imageMessage = session.messages.find((message) => message.role === "user" && message.attachments?.length);
  return imageMessage ? "Image chat" : session.title;
}

function renderPendingAttachments(): void {
  const attachmentPreviewList = assertElement(elements.attachmentPreviewList, "attachmentPreviewList");
  attachmentPreviewList.innerHTML = "";

  for (const attachment of pendingAttachments) {
    const item = document.createElement("article");
    item.className = "attachment-preview-item";

    const image = document.createElement("img");
    image.src = attachment.dataUrl;
    image.alt = attachment.name;

    const meta = document.createElement("div");
    meta.className = "attachment-preview-meta";

    const name = document.createElement("p");
    name.className = "attachment-preview-name";
    name.textContent = attachment.name;

    const size = document.createElement("p");
    size.className = "attachment-preview-size";
    size.textContent = attachment.mimeType;

    meta.append(name, size);

    const removeButton = document.createElement("button");
    removeButton.className = "ghost-button";
    removeButton.type = "button";
    removeButton.textContent = "Remove";
    removeButton.addEventListener("click", () => {
      pendingAttachments = pendingAttachments.filter((itemValue) => itemValue.id !== attachment.id);
      renderPendingAttachments();
    });

    item.append(image, meta, removeButton);
    attachmentPreviewList.append(item);
  }
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsDataURL(file);
  });
}

async function fileToAttachment(file: File): Promise<ImageAttachment> {
  return {
    id: crypto.randomUUID(),
    name: file.name,
    mimeType: file.type,
    dataUrl: await fileToDataUrl(file)
  };
}

async function addAttachmentsFromFiles(files: File[]): Promise<void> {
  if (files.length === 0) {
    return;
  }

  const remainingSlots = Math.max(0, MAX_ATTACHMENTS - pendingAttachments.length);

  if (remainingSlots === 0) {
    throw new Error(`You can attach up to ${MAX_ATTACHMENTS} images.`);
  }

  const selectedFiles = files.slice(0, remainingSlots);

  for (const file of selectedFiles) {
    if (!file.type.startsWith("image/")) {
      throw new Error(`${file.name} is not an image.`);
    }

    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`${file.name} exceeds the ${formatFileSize(MAX_ATTACHMENT_BYTES)} limit.`);
    }
  }

  const nextAttachments = await Promise.all(selectedFiles.map((file) => fileToAttachment(file)));
  pendingAttachments = [...pendingAttachments, ...nextAttachments];
  renderPendingAttachments();
  setStatus(`${pendingAttachments.length} image${pendingAttachments.length === 1 ? "" : "s"} ready.`);
}

function renderSessionControls(state: AppState): void {
  const sessionSelect = assertElement(elements.sessionSelect, "sessionSelect");
  sessionSelect.innerHTML = "";

  for (const session of state.sessions) {
    const option = document.createElement("option");
    option.value = session.id;
    option.textContent = sessionLabel(session);
    option.selected = session.id === state.activeSessionId;
    sessionSelect.append(option);
  }

  assertElement(elements.deleteSessionButton, "deleteSessionButton").disabled = pending || state.sessions.length === 0;
}

function renderMessages(messages: ChatMessage[]): void {
  const chatList = assertElement(elements.chatList, "chatList");
  chatList.innerHTML = "";

  if (messages.length === 0) {
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";
    emptyState.textContent = "No messages yet. Save your provider settings and start chatting.";
    chatList.append(emptyState);
    return;
  }

  for (const message of messages) {
    const item = document.createElement("article");
    item.className = `message message-${message.role} message-${message.status ?? "done"}`;

    const meta = document.createElement("span");
    meta.className = "message-meta";
    meta.textContent =
      message.status === "streaming" ? `${message.role} • streaming` : message.status === "error" ? `${message.role} • error` : message.role;

    const body = document.createElement("div");
    body.className = "message-content";
    renderRichText(body, message.content || (message.status === "streaming" ? "Generating..." : ""));

    item.append(meta, body);

    if (message.attachments?.length) {
      const attachments = document.createElement("div");
      attachments.className = "message-attachments";

      for (const attachment of message.attachments) {
        const image = document.createElement("img");
        image.className = "message-attachment-image";
        image.src = attachment.dataUrl;
        image.alt = attachment.name;
        attachments.append(image);
      }

      item.append(attachments);
    }

    chatList.append(item);
  }

  chatList.scrollTop = chatList.scrollHeight;
}

function renderState(state: AppState): void {
  appState = state;

  assertElement(elements.systemPromptInput, "systemPromptInput").value = state.settings.systemPrompt;
  assertElement(elements.apiTypeSelect, "apiTypeSelect").value = state.settings.local.apiType;
  assertElement(elements.localBaseUrlInput, "localBaseUrlInput").value = state.settings.local.baseUrl;
  assertElement(elements.localModelInput, "localModelInput").value = state.settings.local.model;
  assertElement(elements.pageContextMaxCharsInput, "pageContextMaxCharsInput").value = String(state.settings.pageContextMaxChars);
  const pageContextToggle = assertElement(elements.pageContextToggle, "pageContextToggle");
  const selectedTextOnlyToggle = assertElement(elements.selectedTextOnlyToggle, "selectedTextOnlyToggle");
  pageContextToggle.checked = usePageContext && pageContextAvailable;
  pageContextToggle.disabled = !pageContextAvailable;
  pageContextToggle.title = pageContextAvailable ? "" : "Webpage context is disabled for PDF tabs.";
  selectedTextOnlyToggle.checked = useSelectedTextOnly && pageContextAvailable;
  selectedTextOnlyToggle.disabled = !pageContextAvailable || !usePageContext;
  selectedTextOnlyToggle.title = pageContextAvailable ? "" : "Selected text context is disabled for PDF tabs.";
  renderSessionControls(state);
  renderMessages(getActiveSession(state).messages);
  renderPendingAttachments();
}

function isInspectablePage(url: string): boolean {
  return /^https?:\/\//.test(url);
}

function isPdfUrl(url: string): boolean {
  return /\.pdf($|[?#])/i.test(url) || /\/pdfjs\/web\/viewer\.html/i.test(url);
}

async function syncPageContextAvailability(): Promise<void> {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  const nextAvailable = Boolean(activeTab?.url && isInspectablePage(activeTab.url) && !isPdfUrl(activeTab.url));

  pageContextAvailable = nextAvailable;

  if (!nextAvailable) {
    usePageContext = false;
    useSelectedTextOnly = false;
  }

  if (appState) {
    renderState(appState);
  }
}

function truncatePageText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}\n\n[Truncated]` : normalized;
}

async function getCurrentTabSelectionText(tabId: number): Promise<string> {
  const results = await chrome.scripting.executeScript({
    target: {
      tabId
    },
    func: () => window.getSelection()?.toString() ?? ""
  });

  return (results[0]?.result as string | undefined)?.trim() ?? "";
}

async function getCurrentTabContext(): Promise<ChatMessage | null> {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!activeTab?.id) {
    throw new Error("No active tab is available.");
  }

  if (!activeTab.url || !isInspectablePage(activeTab.url)) {
    throw new Error("Page context is only available on normal http or https webpages.");
  }

  if (isPdfUrl(activeTab.url)) {
    throw new Error("Webpage context is disabled for PDF tabs.");
  }

  await ensureHostPermission(activeTab.url);

  if (useSelectedTextOnly) {
    const selectedText = await getCurrentTabSelectionText(activeTab.id);

    if (!selectedText) {
      throw new Error("No selected text was found on the current webpage.");
    }

    const limitedText = truncatePageText(selectedText, appState?.settings.pageContextMaxChars ?? 12000);
    return createMessage(
      "system",
      `Current selected text context:\nTitle: ${activeTab.title ?? ""}\nURL: ${activeTab.url}\nSelection:\n${limitedText}`
    );
  }

  const results = await chrome.scripting.executeScript({
    target: {
      tabId: activeTab.id
    },
    func: () => {
      const title = document.title || "";
      const url = location.href;
      const text = document.body?.innerText || "";
      return { title, url, text };
    }
  });

  const page = results[0]?.result as
    | {
        title?: string;
        url?: string;
        text?: string;
      }
    | undefined;

  const pageText = truncatePageText(page?.text ?? "", appState?.settings.pageContextMaxChars ?? 12000);

  if (!pageText) {
    return null;
  }

  return createMessage(
    "system",
    `Current webpage context:\nTitle: ${page?.title ?? ""}\nURL: ${page?.url ?? activeTab.url}\nContent:\n${pageText}`
  );
}

function readSettingsFromForm(): AppSettings {
  return {
    systemPrompt: assertElement(elements.systemPromptInput, "systemPromptInput").value.trim(),
    pageContextMaxChars: Number.parseInt(assertElement(elements.pageContextMaxCharsInput, "pageContextMaxCharsInput").value, 10) || 12000,
    local: {
      apiType: assertElement(elements.apiTypeSelect, "apiTypeSelect").value as AppSettings["local"]["apiType"],
      baseUrl: assertElement(elements.localBaseUrlInput, "localBaseUrlInput").value.trim(),
      model: assertElement(elements.localModelInput, "localModelInput").value.trim()
    }
  };
}

async function loadInitialState(): Promise<void> {
  setPendingState(true);
  setStatus("Loading extension state...");

  try {
    const state = await readState();
    renderState(state);
    await syncPageContextAvailability();
    setStatus("Ready.");
  } finally {
    setPendingState(false);
  }
}

async function handleSaveSettings(): Promise<void> {
  setPendingState(true);
  setStatus("Saving settings...");

  try {
    const nextSettings = readSettingsFromForm();
    await ensureHostPermission(nextSettings.local.baseUrl);
    const nextState = await updateSettings(nextSettings);

    renderState(nextState);
    setStatus("Settings saved.");
  } catch (error: unknown) {
    setStatus(error instanceof Error ? error.message : "Failed to save settings.");
  } finally {
    setPendingState(false);
  }
}

async function handleSendMessage(): Promise<void> {
  if (pending) {
    return;
  }

  const input = assertElement(elements.messageInput, "messageInput");
  const content = input.value.trim();

  if (!content && pendingAttachments.length === 0) {
    setStatus("Enter a message or add an image first.");
    return;
  }

  setPendingState(true);
  setStatus("Preparing request...");

  try {
    const currentState = appState ?? (await readState());
    await ensureHostPermission(currentState.settings.local.baseUrl);
    const activeSession = getActiveSession(currentState);
    const pageContextMessage = usePageContext ? await getCurrentTabContext() : null;

    const userMessage = createMessage("user", content);
    userMessage.attachments = [...pendingAttachments];

    const assistantMessage = createMessage("assistant", "", "streaming");
    const updatedSession: ChatSession = {
      ...activeSession,
      messages: [...activeSession.messages, userMessage, assistantMessage]
    };
    const optimisticState: AppState = {
      ...currentState,
      sessions: currentState.sessions.map((session) => (session.id === activeSession.id ? updatedSession : session))
    };

    input.value = "";
    pendingAttachments = [];
    renderState(optimisticState);
    await writeState(optimisticState);
    setStatus("Generating reply...");

    const providerResult = await defaultProvider.streamMessage({
      settings: optimisticState.settings,
      messages: [...activeSession.messages, ...(pageContextMessage ? [pageContextMessage] : []), userMessage],
      onToken: (_chunk, fullText) => {
        assistantMessage.content = fullText;
        const streamingSession: ChatSession = {
          ...updatedSession,
          messages: [...activeSession.messages, userMessage, { ...assistantMessage }]
        };
        const streamingState: AppState = {
          ...optimisticState,
          sessions: currentState.sessions.map((session) => (session.id === activeSession.id ? streamingSession : session))
        };

        renderState(streamingState);
      }
    });

    const finalAssistantMessage: ChatMessage = {
      ...assistantMessage,
      content: providerResult.text,
      status: "done"
    };
    const finalSession: ChatSession = {
      ...updatedSession,
      messages: [...activeSession.messages, userMessage, finalAssistantMessage]
    };
    const finalState: AppState = {
      ...optimisticState,
      sessions: currentState.sessions.map((session) => (session.id === activeSession.id ? finalSession : session))
    };

    renderState(finalState);
    await writeState(finalState);
    setStatus("Reply received.");
  } catch (error: unknown) {
    const currentState = appState ?? (await readState());
    const activeSession = getActiveSession(currentState);
    const lastMessage = activeSession.messages[activeSession.messages.length - 1];

    if (lastMessage?.role === "assistant" && lastMessage.status === "streaming") {
      const failedAssistantMessage: ChatMessage = {
        ...lastMessage,
        content: lastMessage.content || (error instanceof Error ? error.message : "Failed to send message."),
        status: "error"
      };
      const failedSession: ChatSession = {
        ...activeSession,
        messages: [...activeSession.messages.slice(0, -1), failedAssistantMessage]
      };
      const failedState: AppState = {
        ...currentState,
        sessions: currentState.sessions.map((session) => (session.id === activeSession.id ? failedSession : session))
      };

      renderState(failedState);
      await writeState(failedState);
    }

    setStatus(error instanceof Error ? error.message : "Failed to send message.");
  } finally {
    setPendingState(false);
  }
}

async function handleClearChat(): Promise<void> {
  setPendingState(true);
  setStatus("Clearing messages...");

  try {
    const nextState = await clearMessages();
    renderState(nextState);
    setStatus("Chat cleared.");
  } catch (error: unknown) {
    setStatus(error instanceof Error ? error.message : "Failed to clear chat.");
  } finally {
    setPendingState(false);
  }
}

async function handleCreateSession(): Promise<void> {
  setPendingState(true);
  setStatus("Creating session...");

  try {
    const nextState = await createSession();
    renderState(nextState);
    setStatus("New session created.");
  } catch (error: unknown) {
    setStatus(error instanceof Error ? error.message : "Failed to create session.");
  } finally {
    setPendingState(false);
  }
}

async function handleDeleteSession(): Promise<void> {
  setPendingState(true);
  setStatus("Deleting session...");

  try {
    const nextState = await deleteSession();
    renderState(nextState);
    setStatus("Session deleted.");
  } catch (error: unknown) {
    setStatus(error instanceof Error ? error.message : "Failed to delete session.");
  } finally {
    setPendingState(false);
  }
}

async function handleSelectSession(): Promise<void> {
  const sessionId = assertElement(elements.sessionSelect, "sessionSelect").value;
  const nextState = await setActiveSession(sessionId);
  renderState(nextState);
  setStatus("Session changed.");
}

async function handleImageSelection(): Promise<void> {
  const imageInput = assertElement(elements.imageInput, "imageInput");
  const files = Array.from(imageInput.files ?? []);

  if (files.length === 0) {
    return;
  }

  try {
    await addAttachmentsFromFiles(files);
  } catch (error: unknown) {
    setStatus(error instanceof Error ? error.message : "Failed to attach images.");
  } finally {
    imageInput.value = "";
  }
}

async function handlePaste(event: ClipboardEvent): Promise<void> {
  const clipboardFiles =
    event.clipboardData?.items
      ? Array.from(event.clipboardData.items)
          .filter((item) => item.type.startsWith("image/"))
          .map((item) => item.getAsFile())
          .filter((file): file is File => Boolean(file))
      : [];

  if (clipboardFiles.length === 0) {
    return;
  }

  event.preventDefault();

  try {
    await addAttachmentsFromFiles(clipboardFiles);
  } catch (error: unknown) {
    setStatus(error instanceof Error ? error.message : "Failed to paste images.");
  }
}

function wireEvents(): void {
  assertElement(elements.toggleSettingsButton, "toggleSettingsButton").addEventListener("click", () => {
    settingsOpen = !settingsOpen;
    renderSettingsVisibility();
  });

  assertElement(elements.saveSettingsButton, "saveSettingsButton").addEventListener("click", () => {
    void handleSaveSettings();
  });

  assertElement(elements.sessionSelect, "sessionSelect").addEventListener("change", () => {
    void handleSelectSession();
  });

  assertElement(elements.newSessionButton, "newSessionButton").addEventListener("click", () => {
    void handleCreateSession();
  });

  assertElement(elements.deleteSessionButton, "deleteSessionButton").addEventListener("click", () => {
    void handleDeleteSession();
  });

  assertElement(elements.attachImageButton, "attachImageButton").addEventListener("click", () => {
    assertElement(elements.imageInput, "imageInput").click();
  });

  assertElement(elements.imageInput, "imageInput").addEventListener("change", () => {
    void handleImageSelection();
  });

  assertElement(elements.pageContextToggle, "pageContextToggle").addEventListener("change", (event) => {
    if (!pageContextAvailable) {
      usePageContext = false;
      useSelectedTextOnly = false;
      if (appState) {
        renderState(appState);
      }
      return;
    }

    usePageContext = (event.currentTarget as HTMLInputElement).checked;
    if (!usePageContext) {
      useSelectedTextOnly = false;
    }

    if (appState) {
      renderState(appState);
    }
  });

  assertElement(elements.selectedTextOnlyToggle, "selectedTextOnlyToggle").addEventListener("change", (event) => {
    if (!pageContextAvailable || !usePageContext) {
      useSelectedTextOnly = false;
      if (appState) {
        renderState(appState);
      }
      return;
    }

    useSelectedTextOnly = (event.currentTarget as HTMLInputElement).checked;
  });

  assertElement(elements.sendButton, "sendButton").addEventListener("click", () => {
    void handleSendMessage();
  });

  assertElement(elements.clearChatButton, "clearChatButton").addEventListener("click", () => {
    void handleClearChat();
  });

  assertElement(elements.messageInput, "messageInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSendMessage();
    }
  });

  assertElement(elements.messageInput, "messageInput").addEventListener("paste", (event) => {
    void handlePaste(event);
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[APP_STATE_STORAGE_KEY]?.newValue) {
      return;
    }

    renderState(changes[APP_STATE_STORAGE_KEY].newValue as AppState);
  });

  chrome.tabs.onActivated.addListener(() => {
    void syncPageContextAvailability();
  });

  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.status === "complete" || changeInfo.url) {
      void syncPageContextAvailability();
    }
  });
}

renderSettingsVisibility();
wireEvents();
void loadInitialState();
