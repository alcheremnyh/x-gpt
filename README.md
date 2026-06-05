# x-gpt

x-gpt is an open-source web chat for local LLMs served by [Ollama](https://ollama.com/). It is built with C#/.NET 8, ASP.NET Core, SQLite, and Docker.

The project is designed for local-first AI workflows: create projects, keep separate chat branches, switch Ollama models, stream generation in real time, and preserve chat history in a Docker volume.

## Features

- Web chat interface for local Ollama models.
- Streaming responses from Ollama while the model is generating.
- Optional reasoning stream display when the selected model supports Ollama `think`.
- Project-based organization.
- Chat branches with fork points.
- Project-level and branch-level context summary storage.
- Runtime model selection from models available on the Ollama server.
- Optional browser text-to-speech for final assistant answers.
- SQLite persistence in a Docker volume.
- Local configuration through `.env`, kept out of git.

## Tech Stack

- .NET 8
- ASP.NET Core Minimal APIs
- Entity Framework Core
- SQLite
- Docker / Docker Compose
- Ollama HTTP API
- Vanilla HTML, CSS, and JavaScript

## Architecture

```text
Browser UI
  -> ASP.NET Core API
    -> Chat service
      -> SQLite: /app/data/xgpt.db
      -> Ollama: /api/chat, /api/tags
```

Data is stored in SQLite inside the container at:

```text
/app/data/xgpt.db
```

In Docker Compose, `/app/data` is backed by the named Docker volume:

```text
xgpt_data
```

This means chat history survives container rebuilds and restarts.

## Requirements

- Docker Desktop or Docker Engine with Docker Compose.
- An Ollama server reachable from the container.
- At least one Ollama model installed.

Check Ollama locally:

```powershell
ollama list
```

If Ollama runs on the host machine and you use Docker Desktop, this project can use:

```text
http://host.docker.internal:11434
```

If Ollama runs on another machine in your network, use that machine's LAN address.

## Installation

Clone the repository:

```powershell
git clone <your-repository-url>
cd x-gpt
```

Create a local `.env` file:

```powershell
copy .env.example .env
```

Edit `.env`:

```env
OLLAMA_BASE_URL=http://host.docker.internal:11434
OLLAMA_MODEL=llama3.1
```

Start the application:

```powershell
docker compose up -d --build
```

Open:

```text
http://localhost:8080
```

## Configuration

Configuration is provided through environment variables.

| Variable | Description | Example |
| --- | --- | --- |
| `OLLAMA_BASE_URL` | Base URL of your Ollama server | `http://host.docker.internal:11434` |
| `OLLAMA_MODEL` | Default model used when no UI model is selected | `qwen2.5:7b` |

The app also supports ASP.NET Core configuration keys:

```text
Ollama__BaseUrl
Ollama__Model
Storage__DataDirectory
Storage__DatabaseFileName
```

These are already wired in `docker-compose.yml`.

## Security Notes

Do not commit your local `.env`.

The repository `.gitignore` excludes:

- `.env`
- `.env.*`
- `appsettings.Development.json`
- `appsettings.Local.json`
- `appsettings.Secrets.json`

Use `.env.example` for safe public defaults only.

## Usage

1. Open `http://localhost:8080`.
2. Create or select a project.
3. Select a branch.
4. Choose an Ollama model near the message input.
5. Send a prompt.
6. Watch the answer stream into the chat.

The active model is shown below the input:

```text
Using: <model-name>
```

## Projects and Branches

x-gpt organizes conversations as:

```text
Project
  -> Chat Branch
    -> Messages
    -> Branch summaries
  -> Project summaries
```

A branch can be forked from the current branch. The app stores parent branch/message references so branch context can include relevant parent history.

## Context and Summaries

x-gpt stores summaries separately from messages.

Supported summary scopes:

- Branch summary
- Project summary

Context modes:

- `BranchOnly`: use current branch context.
- `ProjectShared`: include project-level summary shared across branches.

Summaries are currently created manually from the UI. Automatic summarization can be added later.

## Model Selection

The app fetches available models from:

```text
GET /api/ollama/models
```

The backend proxies Ollama:

```text
GET <OLLAMA_BASE_URL>/api/tags
```

The selected model is stored in browser `localStorage` and sent with each chat request. If no model is selected, the server uses `OLLAMA_MODEL` from `.env`.

## Streaming and Reasoning

Chat requests use Ollama streaming mode.

When supported by the selected model, x-gpt also requests:

```json
{
  "think": true
}
```

If the model returns thinking chunks, they are displayed in a muted `Reasoning` block. If the model does not support reasoning output, only the final answer stream is shown.

## Text-to-Speech

The UI can read final assistant answers aloud using the browser Web Speech API.

Notes:

- Voice output depends on your browser and operating system voices.
- Russian is selected automatically when the answer contains Cyrillic text.
- Otherwise, the browser language is used.
- Reasoning text is not spoken.

## Data Persistence

Docker Compose stores SQLite data in:

```text
xgpt_data:/app/data
```

The database file is:

```text
/app/data/xgpt.db
```

Normal restarts and rebuilds keep the data:

```powershell
docker compose down
docker compose up -d --build
```

Data is removed only if you delete the volume:

```powershell
docker compose down -v
```

## Backup

To back up the database, copy `xgpt.db` from the Docker volume.

Example:

```powershell
docker compose exec x-gpt ls /app/data
```

You can also create a temporary container to copy the volume contents if needed.

## Development

Run locally with .NET:

```powershell
dotnet restore
dotnet build
dotnet run
```

Run with Docker:

```powershell
docker compose up -d --build
```

View logs:

```powershell
docker compose logs -f x-gpt
```

Stop:

```powershell
docker compose down
```

## API Overview

Health:

```text
GET /api/health
```

Ollama models:

```text
GET /api/ollama/models
```

Projects:

```text
GET /api/projects
POST /api/projects
GET /api/projects/{projectId}
```

Branches:

```text
POST /api/projects/{projectId}/branches
PUT /api/branches/{branchId}/project
```

Messages:

```text
GET /api/branches/{branchId}/messages
POST /api/branches/{branchId}/messages
```

Summaries:

```text
GET /api/projects/{projectId}/summaries
POST /api/branches/{branchId}/summaries
```

## FAQ

### Does x-gpt require internet access?

No, not for chat generation. It talks to your Ollama server. Internet may be needed only to download Docker images, NuGet packages, or Ollama models.

### Can I use Ollama on another machine?

Yes. Set `OLLAMA_BASE_URL` to the LAN URL of that machine, for example:

```env
OLLAMA_BASE_URL=http://192.168.0.119:11434
```

Make sure Ollama is reachable from the Docker container.

### Why does a model return an error about memory?

Large models may require more RAM/VRAM than available. Choose a smaller model in the model selector, for example `qwen2.5:7b`, or install a smaller quantization.

### Why do I not see reasoning?

Only models that support Ollama reasoning output return thinking chunks. If a model does not support it, x-gpt will still stream the final answer.

### Why does text-to-speech not work?

Browser speech synthesis depends on the browser, operating system, installed voices, and autoplay/user-gesture policies. Press `Voice on`; the app will try a short test phrase.

### Is chat history stored in git?

No. Chat history is stored in SQLite inside the Docker volume. Local configuration files are ignored by git.

### Can I change the database location?

Yes. Change:

```text
Storage__DataDirectory
Storage__DatabaseFileName
```

in `docker-compose.yml`.

## Troubleshooting

### `http://localhost:8080` does not open

Check container status:

```powershell
docker compose ps
```

Check logs:

```powershell
docker compose logs x-gpt
```

### Ollama is not reachable

Check from the host:

```powershell
Invoke-RestMethod http://localhost:11434/api/tags
```

If Ollama is on the host and the app runs in Docker, use:

```env
OLLAMA_BASE_URL=http://host.docker.internal:11434
```

If Ollama is on another machine, use that machine's IP address.

### Model list is empty

Verify Ollama has models installed:

```powershell
ollama list
```

Pull a model:

```powershell
ollama pull qwen2.5:7b
```

### Responses are very slow

Local LLM speed depends on model size, hardware, quantization, and current memory pressure. Try a smaller model from the selector.

### Data disappeared

Check whether the Docker volume was removed. This command deletes the volume and the database:

```powershell
docker compose down -v
```

Use `docker compose down` without `-v` to keep data.

## Roadmap Ideas

- Automatic summarization based on context length.
- Search across projects and branches.
- Import/export conversations.
- Authentication for shared deployments.
- Configurable system prompts per project.
- Richer model metadata and performance stats.
- Voice selection UI.

## License

Add a license before publishing the repository as open source. Common choices are MIT, Apache-2.0, or AGPL-3.0 depending on your goals.
