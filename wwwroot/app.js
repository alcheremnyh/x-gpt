const state = {
  projects: [],
  currentProjectId: null,
  currentBranchId: null,
  models: [],
  selectedModel: localStorage.getItem("x-gpt.model") || "",
  messages: [],
  messageWindowStart: 0,
  stickToBottom: true,
  voiceEnabled: localStorage.getItem("x-gpt.voice") === "on"
};

const VISIBLE_MESSAGE_LIMIT = 80;
const MESSAGE_WINDOW_SHIFT = 24;
const SCROLL_EDGE_PX = 32;

const elements = {
  projects: document.querySelector("#projects"),
  branches: document.querySelector("#branches"),
  models: document.querySelector("#models"),
  newProject: document.querySelector("#new-project"),
  forkBranch: document.querySelector("#fork-branch"),
  hero: document.querySelector("#hero"),
  messages: document.querySelector("#messages"),
  messageForm: document.querySelector("#message-form"),
  messageContent: document.querySelector("#message-content"),
  modelCaption: document.querySelector("#model-caption"),
  summarizeBranch: document.querySelector("#summarize-branch"),
  summarizeProject: document.querySelector("#summarize-project"),
  voiceToggle: document.querySelector("#voice-toggle"),
  refresh: document.querySelector("#refresh"),
  status: document.querySelector("#status")
};

elements.projects.addEventListener("change", async () => {
  state.currentProjectId = elements.projects.value || null;
  const project = getCurrentProject();
  state.currentBranchId = project?.branches?.[0]?.id ?? null;
  await render();
  await loadMessages();
});

elements.branches.addEventListener("change", async () => {
  state.currentBranchId = elements.branches.value || null;
  await loadMessages();
});

elements.models.addEventListener("change", () => {
  state.selectedModel = elements.models.value;
  localStorage.setItem("x-gpt.model", state.selectedModel);
  elements.models.closest("details")?.removeAttribute("open");
  render();
});

elements.messageContent.addEventListener("input", resizeComposer);
elements.messageContent.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    elements.messageForm.requestSubmit();
  }
});

elements.messageForm.addEventListener("submit", async event => {
  event.preventDefault();
  await sendMessage();
});

elements.messages.addEventListener("click", handleMessageAction);
window.addEventListener("scroll", handleMessageScroll, { passive: true });
elements.newProject.addEventListener("click", createProject);
elements.forkBranch.addEventListener("click", createBranch);
elements.summarizeBranch.addEventListener("click", () => createSummary("Branch"));
elements.summarizeProject.addEventListener("click", () => createSummary("Project"));
elements.voiceToggle.addEventListener("click", toggleVoice);
elements.refresh.addEventListener("click", refreshAll);

if ("speechSynthesis" in window) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
}

refreshAll();
resizeComposer();

async function refreshAll() {
  setStatus("Loading...");
  await loadModels();
  await loadProjects();
  await loadMessages();
  setStatus("");
}

async function loadModels() {
  try {
    state.models = await api("/api/ollama/models");
    const modelNames = state.models.map(model => model.name);

    if (!state.selectedModel || !modelNames.includes(state.selectedModel)) {
      state.selectedModel = modelNames[0] ?? "";
    }

    if (state.selectedModel) {
      localStorage.setItem("x-gpt.model", state.selectedModel);
    }
  } catch (error) {
    state.models = [];
    setStatus(error.message);
  }
}

async function loadProjects() {
  state.projects = await api("/api/projects");

  if (!state.currentProjectId && state.projects.length > 0) {
    state.currentProjectId = state.projects[0].id;
  }

  const project = getCurrentProject();
  if (!state.currentBranchId && project?.branches?.length > 0) {
    state.currentBranchId = project.branches[0].id;
  }

  await render();
}

async function loadMessages() {
  if (!state.currentBranchId) {
    state.messages = [];
    resetMessageWindow();
    await render();
    return;
  }

  state.messages = await api(`/api/branches/${state.currentBranchId}/messages`);
  resetMessageWindow();
  await render();
  scrollMessagesToBottom();
}

async function createProject() {
  const name = prompt("Project name")?.trim();
  if (!name) {
    return;
  }

  const project = await api("/api/projects", {
    method: "POST",
    body: { name, contextMode: "BranchOnly" }
  });

  state.currentProjectId = project.id;
  state.currentBranchId = project.branches[0]?.id ?? null;
  await refreshAll();
}

async function createBranch() {
  const project = getCurrentProject();
  if (!project || !state.currentBranchId) {
    setStatus("Select a project and branch first.");
    return;
  }

  const name = prompt("Branch name", "fork")?.trim();
  if (!name) {
    return;
  }

  const lastMessage = state.messages.at(-1);
  const branch = await api(`/api/projects/${project.id}/branches`, {
    method: "POST",
    body: {
      name,
      parentBranchId: state.currentBranchId,
      parentMessageId: lastMessage?.id ?? null
    }
  });

  state.currentBranchId = branch.id;
  await refreshAll();
}

async function sendMessage() {
  const content = elements.messageContent.value.trim();
  if (!content || !state.currentBranchId) {
    return;
  }

  elements.messageContent.value = "";
  resizeComposer();
  state.stickToBottom = true;
  state.messages.push({
    id: crypto.randomUUID(),
    branchId: state.currentBranchId,
    role: "user",
    content,
    sequence: state.messages.length + 1,
    createdAt: new Date().toISOString()
  });
  const thinkingMessage = {
    id: crypto.randomUUID(),
    branchId: state.currentBranchId,
    role: "thinking",
    content: "",
    sequence: state.messages.length + 1,
    createdAt: new Date().toISOString()
  };
  const assistantMessage = {
    id: crypto.randomUUID(),
    branchId: state.currentBranchId,
    role: "assistant",
    content: "",
    sequence: state.messages.length + 1,
    createdAt: new Date().toISOString()
  };
  state.messages.push(assistantMessage);
  await render();
  scrollMessagesToBottom();

  setBusy(true);
  setStatus("Generating...");

  try {
    const response = await fetch(`/api/branches/${state.currentBranchId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, model: state.selectedModel || null })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail ?? error.error ?? error.title ?? "Request failed.");
    }

    if (!response.body) {
      throw new Error("Streaming is not supported by this browser.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      buffer = consumeStreamLines(buffer, thinkingMessage, assistantMessage);
      await render();
      if (state.stickToBottom) {
        scrollMessagesToBottom();
      }
      setStatus("");
    }

    buffer += decoder.decode();
    consumeStreamLines(`${buffer}\n`, thinkingMessage, assistantMessage);
    speakFinalAnswer(assistantMessage.content);
    await loadMessages();
    setStatus("");
  } catch (error) {
    setStatus(error.message);
    await loadMessages();
  } finally {
    setBusy(false);
  }
}

async function createSummary(scope) {
  if (!state.currentBranchId) {
    setStatus("Select a branch first.");
    return;
  }

  setBusy(true);
  setStatus(`Creating ${scope.toLowerCase()} summary...`);

  try {
    await api(`/api/branches/${state.currentBranchId}/summaries`, {
      method: "POST",
      body: { scope }
    });
    setStatus(`${scope} summary saved.`);
  } finally {
    setBusy(false);
  }
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    const message = error.detail ?? error.error ?? error.title ?? "Request failed.";
    setStatus(message);
    throw new Error(message);
  }

  return response.json();
}

async function render() {
  const project = getCurrentProject();
  const branch = project?.branches?.find(item => item.id === state.currentBranchId);

  elements.projects.innerHTML = state.projects.length === 0
    ? '<option value="">No projects</option>'
    : state.projects.map(projectItem => (
    `<option value="${projectItem.id}" ${projectItem.id === state.currentProjectId ? "selected" : ""}>${escapeHtml(projectItem.name)}</option>`
  )).join("");

  elements.branches.innerHTML = (project?.branches ?? []).length === 0
    ? '<option value="">No branches</option>'
    : (project?.branches ?? []).map(branchItem => (
    `<option value="${branchItem.id}" ${branchItem.id === state.currentBranchId ? "selected" : ""}>${escapeHtml(branchItem.name)}</option>`
  )).join("");

  elements.models.innerHTML = state.models.length === 0
    ? '<option value="">No models</option>'
    : state.models.map(model => (
    `<option value="${escapeHtml(model.name)}" ${model.name === state.selectedModel ? "selected" : ""}>${escapeHtml(model.name)}</option>`
  )).join("");

  const renderableMessages = getRenderableMessages();
  const windowStart = getMessageWindowStart(renderableMessages.length);
  const visibleMessages = renderableMessages.slice(windowStart, windowStart + VISIBLE_MESSAGE_LIMIT);
  state.messageWindowStart = windowStart;

  elements.messages.innerHTML = visibleMessages
    .map(message => renderMessage(message))
    .join("");

  const hasBranch = Boolean(state.currentBranchId);
  elements.hero.hidden = state.messages.length > 0;
  elements.messageContent.placeholder = hasBranch ? "Ask..." : "Create a project to start...";
  elements.messageContent.disabled = !hasBranch;
  elements.messageForm.querySelector("button").disabled = !hasBranch;
  elements.models.disabled = state.models.length === 0;
  elements.modelCaption.textContent = state.selectedModel ? `Using: ${state.selectedModel}` : "No model selected";
  elements.forkBranch.disabled = !state.currentProjectId || !state.currentBranchId;
  elements.summarizeBranch.disabled = !hasBranch;
  elements.summarizeProject.disabled = !hasBranch;
  elements.voiceToggle.textContent = state.voiceEnabled ? "Voice on" : "Voice off";
  elements.voiceToggle.classList.toggle("is-active", state.voiceEnabled);
  resizeComposer();
}

function getCurrentProject() {
  return state.projects.find(project => project.id === state.currentProjectId);
}

function setBusy(isBusy) {
  elements.messageForm.querySelector("button").disabled = isBusy || !state.currentBranchId;
  elements.summarizeBranch.disabled = isBusy || !state.currentBranchId;
  elements.summarizeProject.disabled = isBusy || !state.currentBranchId;
}

function setStatus(message) {
  elements.status.textContent = message;
}

function renderMessage(message) {
  const actions = message.role === "assistant"
    ? `<div class="message-actions"><button type="button" data-action="copy" data-message-id="${message.id}" title="Copy answer" aria-label="Copy answer">⧉</button><button type="button" data-action="delete-turn" data-message-id="${message.id}" title="Delete question and answer" aria-label="Delete question and answer">×</button></div>`
    : "";

  return `<article class="message ${message.role}" data-message-id="${message.id}"><div class="message-body">${renderMessageContent(message)}</div>${actions}</article>`;
}

async function handleMessageAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }

  try {
    if (button.dataset.action === "copy-code") {
      await copyCodeBlock(button);
      return;
    }

    const messageId = button.dataset.messageId;
    const message = state.messages.find(item => item.id === messageId);
    if (!message) {
      return;
    }

    if (button.dataset.action === "copy") {
      await copyMessage(message);
      return;
    }

    if (button.dataset.action === "delete-turn") {
      await deleteTurn(message);
    }
  } catch (error) {
    setStatus(error.message);
  }
}

async function copyMessage(message) {
  try {
    await navigator.clipboard.writeText(message.content);
    setStatus("Copied.");
  } catch {
    setStatus("Copy failed.");
  }
}

async function copyCodeBlock(button) {
  const code = button.closest(".code-block")?.querySelector("pre code")?.textContent;
  if (!code) {
    setStatus("Code block is empty.");
    return;
  }

  try {
    await navigator.clipboard.writeText(code);
    setStatus("Code copied.");
  } catch {
    setStatus("Code copy failed.");
  }
}

async function deleteTurn(message) {
  const confirmed = confirm("Delete this question and answer from chat history?");
  if (!confirmed || !state.currentBranchId) {
    return;
  }

  await fetch(`/api/branches/${state.currentBranchId}/messages/${message.id}/turn`, {
    method: "DELETE"
  }).then(async response => {
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error ?? "Delete failed.");
    }
  });

  setStatus("Deleted from context.");
  await loadMessages();
}

function resizeComposer() {
  const maxHeight = 144;
  elements.messageContent.style.height = "auto";
  const nextHeight = Math.min(elements.messageContent.scrollHeight, maxHeight);
  elements.messageContent.style.height = `${nextHeight}px`;
  elements.messageContent.style.overflowY = elements.messageContent.scrollHeight > maxHeight ? "auto" : "hidden";
  document.documentElement.style.setProperty(
    "--composer-height",
    `${elements.messageForm.offsetHeight}px`);
}

function getRenderableMessages() {
  return state.messages.filter(message => message.role !== "thinking" || message.content.trim());
}

function getMessageWindowStart(totalMessages) {
  if (totalMessages <= VISIBLE_MESSAGE_LIMIT) {
    return 0;
  }

  const lastWindowStart = totalMessages - VISIBLE_MESSAGE_LIMIT;
  if (state.stickToBottom) {
    return lastWindowStart;
  }

  return Math.max(0, Math.min(state.messageWindowStart, lastWindowStart));
}

function resetMessageWindow() {
  state.messageWindowStart = 0;
  state.stickToBottom = true;
}

function scrollMessagesToBottom() {
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
}

async function handleMessageScroll() {
  const distanceFromBottom = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
  state.stickToBottom = distanceFromBottom <= SCROLL_EDGE_PX;

  if (window.scrollY <= SCROLL_EDGE_PX && state.messageWindowStart > 0) {
    const oldScrollHeight = document.documentElement.scrollHeight;
    const oldScrollY = window.scrollY;
    state.stickToBottom = false;
    state.messageWindowStart = Math.max(0, state.messageWindowStart - MESSAGE_WINDOW_SHIFT);
    await render();
    window.scrollTo({ top: document.documentElement.scrollHeight - oldScrollHeight + oldScrollY, behavior: "auto" });
  }

  if (state.stickToBottom) {
    const totalMessages = getRenderableMessages().length;
    const expectedStart = Math.max(0, totalMessages - VISIBLE_MESSAGE_LIMIT);
    if (state.messageWindowStart !== expectedStart) {
      state.messageWindowStart = expectedStart;
      await render();
      scrollMessagesToBottom();
    }
  }
}

function toggleVoice() {
  if (!("speechSynthesis" in window)) {
    setStatus("Voice is not supported by this browser.");
    return;
  }

  state.voiceEnabled = !state.voiceEnabled;
  localStorage.setItem("x-gpt.voice", state.voiceEnabled ? "on" : "off");

  if (!state.voiceEnabled) {
    window.speechSynthesis.cancel();
  } else {
    speakText("Voice enabled.", { test: true });
  }

  render();
}

function speakFinalAnswer(text) {
  if (!state.voiceEnabled) {
    return;
  }

  speakText(text);
}

function speakText(text, options = {}) {
  if (!("speechSynthesis" in window)) {
    setStatus("Voice is not supported by this browser.");
    return;
  }

  const chunks = splitSpeechText(text);
  if (chunks.length === 0) {
    setStatus("Voice skipped: empty answer.");
    return;
  }

  window.speechSynthesis.cancel();
  setStatus(options.test ? "Testing voice..." : "Speaking...");
  speakChunks(chunks);
}

function speakChunks(chunks) {
  const text = chunks.shift();
  if (!text) {
    setStatus("");
    return;
  }

  const utterance = new SpeechSynthesisUtterance(text);
  const language = detectSpeechLanguage(text);
  const voice = selectVoice(language);
  utterance.lang = language;
  if (voice) {
    utterance.voice = voice;
  }
  utterance.rate = 1;
  utterance.pitch = 1;
  utterance.volume = 1;
  utterance.onend = () => speakChunks(chunks);
  utterance.onerror = event => setStatus(`Voice error: ${event.error || "unknown"}`);

  window.speechSynthesis.speak(utterance);
}

function detectSpeechLanguage(text) {
  if (/[А-Яа-яЁё]/.test(text)) {
    return "ru-RU";
  }

  return navigator.language || "en-US";
}

function selectVoice(language) {
  const voices = window.speechSynthesis.getVoices();
  const normalizedLanguage = language.toLowerCase();

  return voices.find(voice => voice.lang.toLowerCase() === normalizedLanguage)
    ?? voices.find(voice => voice.lang.toLowerCase().startsWith(normalizedLanguage.split("-")[0]))
    ?? null;
}

function splitSpeechText(text) {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .match(/[^.!?]+[.!?]?\s*/g)
    ?.flatMap(sentence => {
      const trimmed = sentence.trim();
      if (trimmed.length <= 220) {
        return [trimmed];
      }

      const chunks = [];
      for (let index = 0; index < trimmed.length; index += 180) {
        chunks.push(trimmed.slice(index, index + 180));
      }

      return chunks;
    })
    .filter(Boolean) ?? [];
}

function consumeStreamLines(buffer, thinkingMessage, assistantMessage) {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    const chunk = JSON.parse(line);
    if (chunk.type === "thinking") {
      if (!state.messages.includes(thinkingMessage)) {
        const assistantIndex = state.messages.indexOf(assistantMessage);
        state.messages.splice(Math.max(assistantIndex, 0), 0, thinkingMessage);
      }

      thinkingMessage.content += chunk.text;
    }

    if (chunk.type === "content") {
      assistantMessage.content += chunk.text;
    }
  }

  return rest;
}

function renderMessageContent(message) {
  if (message.role === "user") {
    return escapeHtml(message.content);
  }

  return renderMarkdown(message.content);
}

function renderMarkdown(markdown) {
  const normalized = normalizeModelText(markdown);
  const lines = normalized.split("\n");
  const html = [];
  let paragraph = [];
  let list = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) {
      return;
    }

    html.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (list.length === 0) {
      return;
    }

    html.push(`<ul>${list.map(item => `<li>${renderInline(item)}</li>`).join("")}</ul>`);
    list = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const fence = trimmed.match(/^```(\w+)?\s*(.*)$/);
    if (fence) {
      flushParagraph();
      flushList();

      const language = fence[1] ?? "";
      const codeLines = [];
      if (fence[2]) {
        codeLines.push(fence[2]);
      }

      let closed = false;
      while (index + 1 < lines.length) {
        index += 1;
        const codeLine = lines[index];
        const closingIndex = codeLine.indexOf("```");

        if (closingIndex >= 0) {
          if (closingIndex > 0) {
            codeLines.push(codeLine.slice(0, closingIndex).trimEnd());
          }

          closed = true;
          break;
        }

        codeLines.push(codeLine);
      }

      html.push(renderCodeBlock(codeLines.join("\n"), language, closed));
      continue;
    }

    if (/^---+$/.test(trimmed)) {
      flushParagraph();
      flushList();
      html.push("<hr>");
      continue;
    }

    if (isTableStart(lines, index)) {
      flushParagraph();
      flushList();

      const tableLines = [];
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        tableLines.push(lines[index].trim());
        index += 1;
      }

      index -= 1;
      html.push(renderTable(tableLines));
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length + 2;
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    const listItem = trimmed.match(/^[-*]\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      list.push(listItem[1]);
      continue;
    }

    flushList();
    paragraph.push(trimmed);
  }

  flushParagraph();
  flushList();

  return html.join("");
}

function normalizeModelText(value) {
  return value
    .replaceAll("$\\rightarrow$", "→")
    .replaceAll("\\rightarrow", "→")
    .replaceAll("$\\leftarrow$", "←")
    .replaceAll("\\leftarrow", "←")
    .replaceAll("$\\Rightarrow$", "⇒")
    .replaceAll("\\Rightarrow", "⇒");
}

function renderInline(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function isTableStart(lines, index) {
  return lines[index]?.trim().startsWith("|")
    && lines[index + 1]?.trim().match(/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/);
}

function renderTable(lines) {
  if (lines.length < 2) {
    return `<p>${renderInline(lines.join(" "))}</p>`;
  }

  const headers = splitTableRow(lines[0]);
  const rows = lines.slice(2).map(splitTableRow);

  return `<div class="table-wrap"><table><thead><tr>${headers
    .map(cell => `<th>${renderInline(cell)}</th>`)
    .join("")}</tr></thead><tbody>${rows
    .map(row => `<tr>${row.map(cell => `<td>${renderInline(cell)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

function renderCodeBlock(code, language, closed) {
  const label = language ? `<div class="code-label">${escapeHtml(language)}</div>` : "";
  const warning = closed ? "" : `<div class="code-warning">Unclosed code block</div>`;
  const copyButton = `<button type="button" class="code-copy" data-action="copy-code" title="Copy code" aria-label="Copy code">⧉</button>`;

  return `<div class="code-block">${label}<pre><code>${escapeHtml(code.trim())}</code></pre>${warning}<div class="code-actions">${copyButton}</div></div>`;
}

function splitTableRow(row) {
  return row
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map(cell => cell.trim());
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
