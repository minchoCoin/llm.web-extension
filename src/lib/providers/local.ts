import type { ChatProvider } from "./types.js";
import type { ChatMessage, ImageAttachment } from "../types.js";

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

function dataUrlToBase64(dataUrl: string): string {
  const commaIndex = dataUrl.indexOf(",");
  return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
}

function toOpenAICompatibleMessage(message: ChatMessage) {
  if (message.role !== "user" || !message.attachments?.length) {
    return {
      role: message.role,
      content: message.content
    };
  }

  const contentParts: Array<
    | {
        type: "text";
        text: string;
      }
    | {
        type: "image_url";
        image_url: {
          url: string;
        };
      }
  > = [];

  if (message.content.trim()) {
    contentParts.push({
      type: "text",
      text: message.content
    });
  }

  for (const attachment of message.attachments) {
    contentParts.push({
      type: "image_url",
      image_url: {
        url: attachment.dataUrl
      }
    });
  }

  return {
    role: message.role,
    content: contentParts
  };
}

function toOllamaMessage(message: ChatMessage) {
  return {
    role: message.role,
    content: message.content,
    ...(message.attachments?.length
      ? {
          images: message.attachments.map((attachment: ImageAttachment) => dataUrlToBase64(attachment.dataUrl))
        }
      : {})
  };
}

function buildMessages(input: Parameters<ChatProvider["streamMessage"]>[0]) {
  return [
    ...(input.settings.systemPrompt
      ? [
          {
            role: "system",
            content: input.settings.systemPrompt
          }
        ]
      : []),
    ...input.messages.map((message) =>
      input.settings.local.apiType === "ollama" ? toOllamaMessage(message) : toOpenAICompatibleMessage(message)
    )
  ];
}

function emitChunk(input: Parameters<ChatProvider["streamMessage"]>[0], chunk: string, fullText: string): void {
  if (!chunk) {
    return;
  }

  input.onToken?.(chunk, fullText);
}

async function readTextStream(
  response: Response,
  onLine: (line: string) => void | Promise<void>
): Promise<void> {
  const reader = response.body?.getReader();

  if (!reader) {
    throw new Error("Streaming response body is not available.");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      buffer += decoder.decode();
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    let newlineIndex = buffer.indexOf("\n");

    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (line) {
        await onLine(line);
      }

      newlineIndex = buffer.indexOf("\n");
    }
  }

  const trailingLine = buffer.trim();

  if (trailingLine) {
    await onLine(trailingLine);
  }
}

function extractOpenAICompatibleDelta(data: unknown): string {
  if (!data || typeof data !== "object") {
    return "";
  }

  const content = (data as {
    choices?: Array<{
      delta?: {
        content?: string | Array<{ text?: string }>;
      };
    }>;
  }).choices?.[0]?.delta?.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item?.text === "string" ? item.text : ""))
      .join("");
  }

  return "";
}

async function streamOpenAICompatibleRequest(input: Parameters<ChatProvider["streamMessage"]>[0]) {
  const response = await fetch(joinUrl(input.settings.local.baseUrl, "/v1/chat/completions"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: input.settings.local.model,
      messages: buildMessages(input),
      stream: true
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Local provider failed (${response.status}): ${text}`);
  }

  let fullText = "";

  await readTextStream(response, async (line) => {
    if (!line.startsWith("data:")) {
      return;
    }

    const payload = line.slice(5).trim();

    if (!payload || payload === "[DONE]") {
      return;
    }

    const data = JSON.parse(payload) as unknown;
    const chunk = extractOpenAICompatibleDelta(data);

    if (!chunk) {
      return;
    }

    fullText += chunk;
    emitChunk(input, chunk, fullText);
  });

  const text = fullText.trim();

  if (!text) {
    throw new Error("Local provider returned an empty response.");
  }

  return { text };
}

async function streamOllamaRequest(input: Parameters<ChatProvider["streamMessage"]>[0]) {
  const response = await fetch(joinUrl(input.settings.local.baseUrl, "/api/chat"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: input.settings.local.model,
      messages: buildMessages(input),
      stream: true
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama provider failed (${response.status}): ${text}`);
  }

  let fullText = "";

  await readTextStream(response, async (line) => {
    const data = JSON.parse(line) as {
      message?: {
        content?: string;
      };
    };
    const chunk = data.message?.content ?? "";

    if (!chunk) {
      return;
    }

    fullText += chunk;
    emitChunk(input, chunk, fullText);
  });

  const text = fullText.trim();

  if (!text) {
    throw new Error("Ollama provider returned an empty response.");
  }

  return { text };
}

export const localProvider: ChatProvider = {
  async sendMessage(input) {
    return this.streamMessage(input);
  },
  async streamMessage(input) {
    if (input.settings.local.apiType === "ollama") {
      return streamOllamaRequest(input);
    }

    return streamOpenAICompatibleRequest(input);
  }
};
