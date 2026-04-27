# llm.extension

TypeScript Chrome extension for chatting with a local LLM server from a Chrome side panel or popup.

## Included

- Manifest V3 extension structure
- popup UI and side panel UI
- side panel chat UI
- background service worker router
- local provider adapter
- `chrome.storage.local` persistence for settings and chat history
- multi-session chat with create, switch, and delete
- local API type switcher for `OpenAI Compatible` and `Ollama`
- multimodal image attachments for compatible local vision models
- optional current-webpage context injection with truncation
- selected-text-only context mode for the active webpage
- markdown and LaTeX math rendering in chat responses
- optimistic user bubbles and streamed assistant updates

## Project structure

```text
public/
  manifest.json
  sidepanel.html
  styles/sidepanel.css
src/
  background.ts
  sidepanel.ts
  lib/
    defaults.ts
    storage.ts
    types.ts
    providers/
      index.ts
      local.ts
scripts/
  copy-static.mjs
  clean.mjs
```

## quick run
1. download [dist.zip](https://github.com/minchoCoin/llm.web-extension/releases/download/v1.0.0/dist.zip) and unzip
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Click `Load unpacked`.
5. Select the `dist` folder.

## Build and run guide

1. Install dependencies.
2. Build the extension.
3. Open `chrome://extensions`.
4. Enable Developer mode.
5. Click `Load unpacked`.
6. Select the generated `dist` folder.

## Commands

```bash
npm install
npm run build
```

## Local LLM notes

The extension supports two local API styles:

- `OpenAI Compatible`
  - `POST {baseUrl}/v1/chat/completions`
- `Ollama`
  - `POST {baseUrl}/api/chat`

Examples:

- LM Studio or vLLM OpenAI server: choose `OpenAI Compatible`
- Ollama default server: choose `Ollama`

When you save settings, Chrome may ask for permission to access the host you entered. That is expected when using a custom local address or LAN IP.

## Image inputs

You can attach images from the popup or side panel when using a local multimodal model.

- `OpenAI Compatible`: images are sent as `image_url` content parts
- `Ollama`: images are sent as base64 entries in the message `images` array

Current MVP limits:

- up to 3 images per message
- up to 2 MB per image
- images are stored in extension state
- the extension requests Chrome's `unlimitedStorage` permission to reduce quota pressure

## Webpage context

You can toggle `Use this webpage as context` in the chat composer.

- when enabled, the extension reads the active page title, URL, and visible text
- you can also enable `Use selected text only` to send just the current text selection
- that page context is sent with the current request only
- the extracted page text is truncated to keep prompts from growing too large

Current MVP behavior:

- works on normal `http` and `https` pages
- selected-text mode requires an active text selection on the page
- does not store webpage content in session history
- very large pages can still increase latency and token usage

## Next steps

- add streaming responses
- add per-tab or per-site chat sessions
- add current-page context capture via content scripts
