# Rubin 🤖

A VS Code extension that provides AI-powered code completions, chat, and **autonomous agent mode** using local LLMs through Ollama. Like GitHub Copilot, but 100% local and private!

![Rubin Demo](https://img.shields.io/badge/Ollama-Powered-blue) ![VS Code](https://img.shields.io/badge/VS%20Code-Extension-007ACC)

## ✨ Features

- 🔌 **Inline Code Completions** - Ghost text suggestions as you type
- 💬 **Chat Sidebar** - Ask questions, explain code, get help
- 🤖 **Agent Mode** - Autonomous AI that can run commands, read/write files, and complete multi-step tasks
- 🎯 **Model Selector** - Switch between models directly in chat
- 🏠 **100% Local** - All inference happens on your machine
- ⚙️ **Configurable** - Choose your model, adjust parameters
- 📊 **Status Bar** - See connection status and current model

## 📋 Prerequisites

1. **Install Ollama**
   ```bash
   brew install ollama
   ```

2. **Start Ollama server**
   ```bash
   ollama serve
   ```

3. **Pull a code model**
   ```bash
   ollama pull deepseek-coder:6.7b  # Recommended for code
   # or
   ollama pull codellama            # Great for completions
   # or
   ollama pull gemma:2b             # Lightweight option
   ```

## 🚀 Installation

### From VSIX
1. Download the latest `.vsix` from releases
2. In VS Code: `Cmd+Shift+P` → "Install from VSIX"
3. Select the downloaded file
4. Reload VS Code

### Development Mode
```bash
git clone https://github.com/restlessankyyy/rubin-vscode.git
cd rubin-vscode
npm install
npm run compile
# Press F5 to launch Extension Development Host
```

### Build VSIX
```bash
npm install -g @vscode/vsce
vsce package --allow-missing-repository
```

## 💡 Usage

### Inline Completions
1. Start typing code in any file
2. Wait for ghost text suggestions to appear
3. Press `Tab` to accept the suggestion
4. Press `Escape` to dismiss

### Chat
1. Press `Cmd+Shift+R` to open Rubin Chat
2. Or click the 🤖 icon in the activity bar
3. Ask questions about your code
4. Select code and right-click → "Rubin: Ask About Selected Code"

### Agent Mode
1. Press `Cmd+Shift+G` to open Agent Mode
2. Describe a task (e.g., "Create a hello.ts file with a greeting function")
3. Watch the agent work step-by-step
4. Agent can:
   - Run terminal commands
   - Read and write files
   - Search your workspace
   - Complete multi-step tasks autonomously

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+R` | Open Rubin Chat |
| `Cmd+Shift+G` | Open Agent Mode |
| `Cmd+Shift+A` | Ask about selected code |
| `Tab` | Accept inline completion |
| `Escape` | Dismiss suggestion |

## 🎛️ Commands

- **Rubin: Toggle Enable/Disable** - Turn completions on/off
- **Rubin: Select Model** - Choose from available Ollama models
- **Rubin: Check Ollama Connection** - Verify connectivity
- **Rubin: Open Chat** - Open the chat sidebar
- **Rubin: Ask About Selected Code** - Chat about selected code
- **Rubin: Start Agent Mode** - Open autonomous agent panel

## ⚙️ Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `rubin.enabled` | `true` | Enable/disable completions |
| `rubin.serverUrl` | `http://localhost:11434` | Ollama server URL |
| `rubin.model` | `codellama` | Model for completions |
| `rubin.maxTokens` | `150` | Max tokens to generate |
| `rubin.temperature` | `0.2` | Generation temperature (0-1) |
| `rubin.debounceMs` | `300` | Debounce delay in ms |
| `rubin.contextLines` | `50` | Lines of context to include |

## 🔧 Recommended Models

| Model | Size | Best For |
|-------|------|----------|
| `deepseek-coder:6.7b` | 3.8 GB | Code completion & chat |
| `codellama` | 3.8 GB | Code-focused tasks |
| `gemma:2b` | 1.7 GB | Fast, lightweight chat |

## 🐛 Troubleshooting

**No completions appearing?**
- Run `Cmd+Shift+P` → "Rubin: Check Ollama Connection"
- Make sure Ollama is running (`ollama serve`)
- Check that your model is installed (`ollama list`)

**Completions are slow?**
- Try a smaller model (e.g., `gemma:2b`)
- Reduce `maxTokens` setting
- Ensure your machine has enough RAM

**Chat not responding?**
- Check the model selector dropdown
- Refresh models with the 🔄 button
- Verify Ollama connection

## 📄 License

MIT

## 🙏 Acknowledgments

- [Ollama](https://ollama.ai/) - Local LLM inference
- [VS Code Extension API](https://code.visualstudio.com/api) - Extension framework
