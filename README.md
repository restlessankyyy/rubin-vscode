# Local Copilot

A VS Code extension that provides AI-powered code completions using local LLMs through Ollama. Like GitHub Copilot, but 100% local and private!

## Features

- 🔌 **Inline Code Completions** - Ghost text suggestions as you type
- 🏠 **100% Local** - All inference happens on your machine
- ⚙️ **Configurable** - Choose your model, adjust parameters
- 📊 **Status Bar** - See connection status and current model

## Prerequisites

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
   ollama pull codellama    # Recommended for code
   # or
   ollama pull gemma:7b     # Good alternative
   # or
   ollama pull deepseek-coder:6.7b  # Another good option
   ```

## Installation

### Development Mode
1. Open this folder in VS Code
2. Run `npm install`
3. Run `npm run compile`
4. Press `F5` to launch Extension Development Host

### Build VSIX (Optional)
```bash
npm install -g @vscode/vsce
vsce package
```

## Usage

1. Start typing code in any file
2. Wait for ghost text suggestions to appear
3. Press `Tab` to accept the suggestion
4. Press `Escape` to dismiss

## Commands

- **Local Copilot: Toggle Enable/Disable** - Turn completions on/off
- **Local Copilot: Select Model** - Choose from available Ollama models
- **Local Copilot: Check Connection** - Verify Ollama connectivity

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `localCopilot.enabled` | `true` | Enable/disable completions |
| `localCopilot.serverUrl` | `http://localhost:11434` | Ollama server URL |
| `localCopilot.model` | `codellama` | Model for completions |
| `localCopilot.maxTokens` | `150` | Max tokens to generate |
| `localCopilot.temperature` | `0.2` | Generation temperature |
| `localCopilot.debounceMs` | `300` | Debounce delay (ms) |
| `localCopilot.contextLines` | `50` | Lines of context |

## Tips

- **Start with `codellama`** - It's specifically trained for code completion
- **Lower temperature** values (0.1-0.3) give more deterministic results
- **Increase context lines** if you need more context awareness
- **Reduce debounce** for faster suggestions (may increase CPU usage)

## Troubleshooting

**No completions appearing?**
- Run "Local Copilot: Check Connection" command
- Make sure Ollama is running (`ollama serve`)
- Check that your model is installed (`ollama list`)

**Completions are slow?**
- Try a smaller model (e.g., `codellama:7b` instead of `codellama:13b`)
- Reduce `maxTokens` setting
- Ensure your machine has enough RAM for the model

## License

MIT
