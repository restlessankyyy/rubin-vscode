# Rubin 🤖

<p align="center">
  <img src="https://img.shields.io/badge/Ollama-Powered-blue?style=for-the-badge" alt="Ollama Powered"/>
  <img src="https://img.shields.io/badge/VS%20Code-Extension-007ACC?style=for-the-badge" alt="VS Code Extension"/>
  <img src="https://img.shields.io/badge/100%25-Private-green?style=for-the-badge" alt="100% Private"/>
  <img src="https://img.shields.io/badge/v0.7.0-Latest-orange?style=for-the-badge" alt="v0.7.0"/>
</p>

<p align="center">
  <strong>Your AI coding assistant that runs entirely on your machine.</strong>
  <br>
  Streaming Chat • 12 Slash Commands • Autonomous Agent • @Mentions • Smart Context • MCP Servers
</p>

---

## 🔥 Why Rubin?

- **🔒 100% Private** - Your code never leaves your machine
- **⚡ Fast** - Local inference with no network latency
- **💰 Free** - No subscriptions, no API costs
- **🌐 Offline** - Works without internet
- **🎯 Powerful** - Agent mode can execute multi-step tasks autonomously

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

# In another terminal - pick your model:
ollama pull qwen2.5-coder:7b    # Fast & capable (recommended)
ollama pull deepseek-coder:6.7b # Best quality
ollama pull codellama:7b        # Good for completions
```

### 3. Install Rubin

1. Open VS Code
2. `Cmd+Shift+X` → Search "Rubin"
3. Click Install
4. Open the Rubin sidebar (🤖 icon)

---

## ⚙️ Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `rubin.serverUrl` | `http://localhost:11434` | Ollama server URL |
| `rubin.model` | `qwen2.5-coder:7b` | Model for completions/chat |
| `rubin.enableCompletions` | `true` | Enable inline completions |
| `rubin.maxTokens` | `256` | Max tokens for completions |
| `rubin.temperature` | `0.2` | Creativity (0-1) |
| `rubin.debounceTime` | `300` | Completion delay (ms) |
| `rubin.mcpServers` | `[]` | MCP server configurations |

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
| Fast completions | `qwen2.5-coder:3b` |
| Quality completions | `deepseek-coder:6.7b` |
| General chat | `qwen2.5-coder:7b` |
| Complex tasks | `deepseek-coder:33b` |

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
│         ┌─────────▼─────────┐                               │
│         │   Ollama Client   │ ◄── Streaming Support         │
│         │  (HTTP Client)    │                               │
│         └─────────┬─────────┘                               │
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
              │  │  codellama, etc.) │  │
              │  └───────────────────┘  │
              └─────────────────────────┘
```

---

## 📁 Project Structure

```
rubin/
├── src/
│   ├── extension.ts      # Entry point
│   ├── ollamaClient.ts   # HTTP client with streaming
│   ├── unifiedPanel.ts   # Chat/Agent webview
│   ├── agentProvider.ts  # Autonomous agent (14+ tools)
│   ├── mcpClient.ts      # MCP server integration
│   ├── completionProvider.ts  # Inline completions
│   ├── slashCommands.ts  # 12 slash commands
│   ├── participants.ts   # @mentions system
│   ├── codeActions.ts    # Right-click menu
│   ├── inlineChat.ts     # Inline edit
│   ├── gitIntegration.ts # Commit message generator
│   ├── smartContext.ts   # Intelligent context selection
│   ├── prompts.ts        # System prompts
│   └── config.ts         # Settings management
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

- [Ollama](https://ollama.ai/) - Local LLM runtime
- [VS Code API](https://code.visualstudio.com/api) - Extension platform

---

<p align="center">
  <strong>Made with ❤️ for developers who value privacy</strong>
  <br>
  <a href="https://github.com/restlessankyyy/rubin-vscode">GitHub</a> •
  <a href="https://github.com/restlessankyyy/rubin-vscode/issues">Issues</a> •
  <a href="https://github.com/restlessankyyy/rubin-vscode/releases">Releases</a>
</p>
