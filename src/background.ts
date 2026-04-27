import { readState } from "./lib/storage.js";

chrome.runtime.onInstalled.addListener(async () => {
  await readState();
});
