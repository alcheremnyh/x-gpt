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

elements.messageForm.addEventListener("submit", async event => {
  event.preventDefault();
  await sendMessage();
});

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
    .map(message => `<article class="message ${message.role}">${escapeHtml(message.content)}</article>`)
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
