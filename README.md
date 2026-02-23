# Rubin – Claude for VS Code 🤖

<p align="center">
  <img src="https://img.shields.io/badge/Claude-Powered-CC785C?style=for-the-badge" alt="Claude Powered"/>
  <img src="https://img.shields.io/badge/Ollama-Local-blue?style=for-the-badge" alt="Ollama Local"/>
  <img src="https://img.shields.io/badge/100%25-Private-green?style=for-the-badge" alt="100% Private"/>
  <img src="https://img.shields.io/badge/v0.9.0-Latest-orange?style=for-the-badge" alt="v0.9.0"/>
</p>

<p align="center">
  <strong>Claude for VS Code — runs 100% locally on Ollama. Real Anthropic API optionally.</strong>
  <br>
  Streaming Chat • 12 Slash Commands • Autonomous Agent • @Mentions • MCP Servers • Persistent Memory • Claude Models
</p>

---

## 🔥 Why Rubin?

- **🔒 100% Private** — Code never leaves your machine (local-first by design)
- **⚡ Fast** — Local inference, zero network latency
- **💰 Free** — No subscriptions. No API costs. Local models are free forever
- **🌐 Offline** — Works without internet
- **🧠 Claude-Powered** — `qwen3-coder` is Claude-compatible and runs locally
- **☁️ Optional Real Claude** — Add an Anthropic API key to unlock `claude-sonnet-4-5`, `claude-opus-4-5` etc
- **🎯 Agentic** — Agent mode autonomously edits files, searches code, and runs commands

---

## ✨ Features

### 💬 Streaming Chat with @Mentions

Real-time streaming responses. Use @mentions to include specific context:

| Mention | Description |
|---------|-------------|
| `@workspace` | Include workspace structure and summary |
| `@file:path/to/file.ts` | Include specific file contents |
| `@terminal` | Include terminal information |
| `@git` | Include git status, branch, and diffs |
| `@selection` | Include current editor selection |
| `@problems` | Include workspace diagnostics |
| `@symbols` | Include symbols from current file |
| `@docs` | Search documentation files |

**Example:** "How do I use the function in @file:utils.ts with @selection?"

### ⌨️ Slash Commands

Type `/` to access 12 powerful commands:

| Command | Description |
|---------|-------------|
| `/explain` | Explain selected code in detail |
| `/fix` | Find and fix bugs in code |
| `/tests` | Generate unit tests |
| `/doc` | Add documentation comments |
| `/optimize` | Improve performance |
| `/refactor` | Improve code structure |
| `/review` | Code review with suggestions |
| `/simplify` | Reduce code complexity |
| `/convert` | Convert to another language |
| `/commit` | Generate git commit message |
| `/terminal` | Generate terminal commands |
| `/help` | Show all available commands |

### 🤖 Autonomous Agent Mode

The most powerful feature! Switch to Agent mode for multi-step tasks with 14 tools:

**File Operations:**
- `readFile` - Read file contents
- `writeFile` - Create/overwrite files
- `editFile` - Edit specific line ranges
- `insertCode` - Insert code at specific lines
- `deleteFile` - Delete files or directories
- `createDirectory` - Create directories

**Search & Analysis:**
- `searchFiles` - Find files by glob pattern
- `searchCode` - Search text across workspace
- `getSymbols` - Get symbols in a file
- `findReferences` - Find all references to a symbol
- `listDirectory` - List directory contents

**Git Integration:**
- `getGitStatus` - Get modified/staged files
- `gitDiff` - Get file diffs

**Command Execution:**
- `runCommand` - Execute terminal commands

All sensitive operations require user approval for safety!

### � MCP Server Integration

Extend Rubin's capabilities with **Model Context Protocol (MCP)** servers:

```json
// settings.json
"rubin.mcpServers": [
  {
    "name": "filesystem",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
    "enabled": true
  },
  {
    "name": "github",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": { "GITHUB_TOKEN": "your-token" }
  }
]
```

**Popular MCP Servers:**
| Server | Description |
|--------|-------------|
| `@modelcontextprotocol/server-filesystem` | File system operations |
| `@modelcontextprotocol/server-github` | GitHub API integration |
| `@modelcontextprotocol/server-postgres` | PostgreSQL database access |
| `@modelcontextprotocol/server-brave-search` | Web search capabilities |

MCP tools appear automatically in Agent mode with `mcp_` prefix!

### �🖱️ Code Actions (Right-Click Menu)

Select code → Right-click → "Rubin" submenu:
- **Explain with Rubin** - Get explanation
- **Fix with Rubin** - Fix bugs
- **Generate Tests** - Create unit tests
- **Add Documentation** - Add comments
- **Optimize Code** - Improve performance
- **Refactor Code** - Improve structure

### ✏️ Inline Edit

1. Select code
2. Press `Cmd+Shift+I` (Mac) or `Ctrl+Shift+I` (Windows/Linux)
3. Describe changes → AI replaces selection

### 🔌 Inline Completions

Ghost text suggestions appear as you type. Press `Tab` to accept.

Supports Fill-in-the-Middle (FIM) for:
- CodeLlama
- DeepSeek Coder
- Qwen Coder
- StarCoder

### 💡 Smart Context

Rubin automatically gathers relevant context:
- Current file and cursor position
- Imported/related files
- Recently edited files
- Workspace structure
- Diagnostics and problems

### 📝 Follow-Up Suggestions

After each response, Rubin suggests helpful next actions like:
- "Generate tests for this"
- "Add error handling"
- "Show usage example"

### 🧠 Claude Models — Local & Cloud

**Local Claude-compatible models (default, free, private):**

| Model | Pull Command | Best For |
|-------|-------------|----------|
| `qwen3-coder` | `ollama pull qwen3-coder` | Code generation ← **default** |
| `glm-4.7` | `ollama pull glm-4.7` | General reasoning |
| `gpt-oss:20b` | `ollama pull gpt-oss:20b` | Balanced tasks |
| `gpt-oss:120b` | `ollama pull gpt-oss:120b` | Complex tasks |

**Real Anthropic API models (optional, requires API key):**

| Model | Description |
|-------|-------------|
| `claude-opus-4-5` | Most powerful |
| `claude-sonnet-4-5` | Best balance |
| `claude-haiku-3-5` | Fastest |
| `claude-3-5-sonnet-20241022` | Prior generation |

To enable real Claude: `Cmd+Shift+P` → **Rubin: Set Anthropic API Key** → paste your key → done.
Real Claude models appear at the **top** of the model dropdown. Without a key, everything runs locally.

### 💾 Persistent Chat Memory

Conversation history is automatically saved to VS Code's encrypted storage and **restored when you reopen the panel** — even after restarting VS Code. Use **Clear Chat** to wipe it.

---

## 🚀 Quick Start

### 1. Install Ollama

```bash
# macOS
brew install ollama

# Linux  
curl -fsSL https://ollama.ai/install.sh | sh

# Windows - Download from https://ollama.ai/download
```

### 2. Start Ollama & Pull a Model

```bash
ollama serve

# Pull the default Claude-compatible model (recommended)
ollama pull qwen3-coder

# Or other models:
ollama pull deepseek-coder:6.7b  # FIM completions
ollama pull llama3.1:8b          # General chat
```

### 3. Install Rubin

1. Open VS Code
2. `Cmd+Shift+X` → Search **"Rubin Claude"**
3. Click Install → open sidebar 🤖

### 4. (Optional) Enable Real Claude API

```
Cmd+Shift+P → "Rubin: Set Anthropic API Key" → paste sk-ant-...
```
Keep empty to stay 100% local and free.

---

## ⚙️ Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `rubin.serverUrl` | `http://localhost:11434` | Ollama server URL |
| `rubin.model` | `qwen3-coder:latest` | Active model |
| `rubin.maxTokens` | `150` | Max tokens for inline completions |
| `rubin.temperature` | `0.2` | Creativity (0–1) |
| `rubin.debounceMs` | `300` | Completion trigger delay (ms) |
| `rubin.mcpServers` | `[]` | MCP server list |

**API key** is stored in VS Code SecretStorage (encrypted), not in `settings.json`. Use the command palette to set it.

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+R` | Open Rubin Chat |
| `Cmd+Shift+I` | Inline Edit Selection |
| `Tab` | Accept completion |
| `Escape` | Dismiss completion |

---

## 🎯 Best Practices

### For Best Completions
- Use models with FIM support (CodeLlama, DeepSeek)
- Keep temperature low (0.1-0.3)
- Write clear comments describing intent

### For Best Chat/Agent Responses
- Use larger models (7B+)
- Attach relevant files
- Use @mentions for specific context
- Be specific in your requests

### Model Recommendations

| Use Case | Recommended Model |
|----------|-------------------|
| Fast completions | `deepseek-coder:6.7b` |
| Local Claude coding | `qwen3-coder` ← **default** |
| Local Claude heavy | `gpt-oss:20b` |
| Best quality (cloud) | `claude-opus-4-5` |
| Best balance (cloud) | `claude-sonnet-4-5` |
| Fastest (cloud) | `claude-haiku-3-5` |

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      VS Code Extension                       │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Completion   │  │    Chat      │  │      Agent       │  │
│  │  Provider    │  │   Panel      │  │     Provider     │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘  │
│         │                 │                    │            │
│         └─────────┬───────┴────────────────────┘            │
│                   │                                          │
│         ┌─────────▼───────────────────────────────┐      │
│         │  AnthropicClient   api.anthropic.com  │ ☁️   │
│         │  ClaudeOllamaClient /api/chat (local) │ ⚡   │
│         │  OllamaClient      /api/generate      │ 🖥️   │
│         └─────────┬───────────────────────────────┘      │
│                   │                                          │
│  ┌────────────────┼────────────────────────────────────┐   │
│  │                │       Context Layer                 │   │
│  │  ┌─────────────▼───────────────┐                    │   │
│  │  │      Smart Context          │                    │   │
│  │  │  (Imports, Related Files)   │                    │   │
│  │  └─────────────────────────────┘                    │   │
│  │  ┌──────────────┐  ┌───────────────┐               │   │
│  │  │ Participants │  │ Slash Commands│               │   │
│  │  │ (@mentions)  │  │ (12 commands) │               │   │
│  │  └──────────────┘  └───────────────┘               │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
              ┌─────────────────────────┐
              │    Ollama Server        │
              │   (localhost:11434)     │
              │                         │
              │  ┌───────────────────┐  │
              │  │   Local LLM       │  │
              │  │ (qwen, deepseek,  │  │
              │  │  qwen3-coder,     │  │
              │  │  gpt-oss, glm...) │  │
              │  └───────────────────┘  │
              └─────────────────────────┘
```

---

## 📁 Project Structure

```
rubin/
├── src/
│   ├── extension.ts           # Entry point + commands
│   ├── anthropicClient.ts    # Real Anthropic API client (v0.9.0)
│   ├── claudeOllamaClient.ts # Local Claude /api/chat client
│   ├── ollamaClient.ts       # Ollama /api/generate client
│   ├── unifiedPanel.ts       # Chat/Agent webview + routing
│   ├── agentProvider.ts      # Autonomous agent (14+ tools)
│   ├── mcpClient.ts          # MCP server integration
│   ├── completionProvider.ts # Inline completions
│   ├── slashCommands.ts      # 12 slash commands
│   ├── participants.ts       # @mentions system
│   ├── codeActions.ts        # Right-click menu
│   ├── inlineChat.ts         # Inline edit
│   ├── gitIntegration.ts     # Commit message generator
│   ├── smartContext.ts       # Intelligent context selection
│   ├── prompts.ts            # System prompts
│   └── config.ts             # Settings + SecretStorage
├── docs/
│   └── ARCHITECTURE.md   # Technical documentation
├── package.json
└── README.md
```

---

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run `npm run lint && npm run compile`
5. Submit a pull request

---

## 📄 License

MIT License - See [LICENSE](LICENSE) for details.

---

## 🙏 Credits

- [Ollama](https://ollama.ai/) — Local LLM runtime
- [Anthropic](https://anthropic.com/) — Claude API
- [VS Code API](https://code.visualstudio.com/api) — Extension platform

---

<p align="center">
  <strong>Made with ❤️ for developers who value privacy</strong>
  <br>
  <a href="https://github.com/restlessankyyy/rubin-vscode">GitHub</a> •
  <a href="https://github.com/restlessankyyy/rubin-vscode/issues">Issues</a> •
  <a href="https://github.com/restlessankyyy/rubin-vscode/releases">Releases</a>
</p>
