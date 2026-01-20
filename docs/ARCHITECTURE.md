# Rubin Architecture

This document provides a comprehensive overview of the Rubin VS Code extension architecture, design decisions, and implementation details.

## Table of Contents

1. [Overview](#overview)
2. [Core Components](#core-components)
3. [Data Flow](#data-flow)
4. [Module Details](#module-details)
5. [Agent System](#agent-system)
6. [Security Model](#security-model)
7. [Extension Points](#extension-points)

---

## Overview

Rubin is a VS Code extension that provides AI-powered coding assistance using local LLMs through Ollama. The extension is designed with the following principles:

- **Privacy First**: All inference happens locally, no data leaves your machine
- **Modular Architecture**: Each feature is isolated and independently testable
- **Extensible**: Easy to add new tools, commands, and capabilities
- **Responsive**: Non-blocking operations with proper cancellation support

### Technology Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js (VS Code Extension Host) |
| Language | TypeScript 5.x |
| UI | VS Code Webview API |
| LLM Backend | Ollama HTTP API |
| Build | TypeScript Compiler (tsc) |

---

## Core Components

```
src/
├── extension.ts          # Entry point, activation, command registration
├── config.ts             # Configuration management
├── logger.ts             # Centralized logging
├── ollamaClient.ts       # HTTP client for Ollama API
├── mcpClient.ts          # MCP server management
├── completionProvider.ts # Inline code completions
├── chatProvider.ts       # Chat sidebar (legacy)
├── unifiedPanel.ts       # Combined chat + agent webview
├── agentProvider.ts      # Autonomous agent logic
├── agentPanel.ts         # Agent webview panel (legacy)
└── contextManager.ts     # Workspace context gathering
```

### Component Diagram

```
┌────────────────────────────────────────────────────────────────────┐
│                        VS Code Extension Host                       │
├────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐│
│  │   extension.ts  │  │    config.ts    │  │     logger.ts       ││
│  │   (Activation)  │  │  (Settings)     │  │   (Output Channel)  ││
│  └────────┬────────┘  └────────┬────────┘  └──────────┬──────────┘│
│           │                    │                       │           │
│  ┌────────▼────────────────────▼───────────────────────▼────────┐ │
│  │                      Core Services Layer                      │ │
│  ├──────────────────────────────────────────────────────────────┤ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐  │ │
│  │  │ Completion   │  │   Unified    │  │      Agent         │  │ │
│  │  │  Provider    │  │    Panel     │  │     Provider       │  │ │
│  │  └──────┬───────┘  └──────┬───────┘  └─────────┬──────────┘  │ │
│  │         │                 │                     │             │ │
│  │  ┌──────▼─────────────────▼─────────────────────▼──────────┐ │ │
│  │  │                   Context Manager                        │ │ │
│  │  │    (Active File, Selection, Diagnostics, Open Tabs)     │ │ │
│  │  └──────────────────────────┬───────────────────────────────┘ │ │
│  └─────────────────────────────┼─────────────────────────────────┘ │
│                                │                                   │
│  ┌─────────────────────────────▼─────────────────────────────────┐ │
│  │                       Ollama Client                            │ │
│  │              (HTTP Requests, Streaming, Cancellation)          │ │
│  └─────────────────────────────┬─────────────────────────────────┘ │
│                                │                                   │
└────────────────────────────────┼───────────────────────────────────┘
                                 │ HTTP
                    ┌────────────▼────────────┐
                    │      Ollama Server      │
                    │   (localhost:11434)     │
                    ├─────────────────────────┤
                    │  ┌─────┐ ┌─────┐ ┌────┐│
                    │  │Model│ │Model│ │... ││
                    │  └─────┘ └─────┘ └────┘│
                    └─────────────────────────┘
```

---

## Data Flow

### Inline Completion Flow

```
User Types Code
      │
      ▼
┌─────────────────────┐
│ Debounce (300ms)    │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Check if Enabled    │──No──► Return null
└──────────┬──────────┘
           │ Yes
           ▼
┌─────────────────────┐
│ Build Prompt        │
│ - Get prefix/suffix │
│ - Format for model  │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Ollama Generate API │
│ POST /api/generate  │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Clean Response      │
│ - Remove artifacts  │
│ - Limit lines       │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Return Completion   │
│ (Ghost Text)        │
└─────────────────────┘
```

### Chat Flow

```
User Message
      │
      ▼
┌─────────────────────┐
│ Gather Context      │
│ - Active file       │
│ - Selection         │
│ - Attached files    │
│ - Diagnostics       │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Build Chat Prompt   │
│ - System prompt     │
│ - Context           │
│ - History (last 6)  │
│ - User message      │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Ollama Generate API │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Display Response    │
│ (Markdown rendered) │
└─────────────────────┘
```

### Agent Flow

```
User Task Description
         │
         ▼
┌────────────────────────┐
│ Build System Prompt    │
│ (Tool definitions)     │
└───────────┬────────────┘
            │
            ▼
    ┌───────────────┐
    │ Generate      │◄──────────────────┐
    │ Response      │                   │
    └───────┬───────┘                   │
            │                           │
            ▼                           │
    ┌───────────────┐                   │
    │ Parse Tool    │                   │
    │ Call?         │                   │
    └───────┬───────┘                   │
            │                           │
       ┌────┴────┐                      │
       │         │                      │
      Yes        No                     │
       │         │                      │
       ▼         ▼                      │
┌────────────┐  ┌─────────────┐        │
│ Needs      │  │ Final       │        │
│ Approval?  │  │ Response    │        │
└─────┬──────┘  └─────────────┘        │
      │                                 │
 ┌────┴────┐                           │
 │         │                           │
Yes        No                          │
 │         │                           │
 ▼         ▼                           │
┌──────┐  ┌──────────────┐             │
│Prompt│  │ Execute Tool │             │
│User  │  └──────┬───────┘             │
└──┬───┘         │                     │
   │             ▼                     │
   │      ┌──────────────┐             │
   │      │ Add Result   │             │
   │      │ to History   │─────────────┘
   │      └──────────────┘
   │
   ▼
┌──────────┐
│ Approved?│
└────┬─────┘
     │
┌────┴────┐
│         │
Yes       No
│         │
▼         ▼
Execute   Return
Tool      Error
```

---

## Module Details

### extension.ts

**Purpose**: Extension entry point and lifecycle management.

**Responsibilities**:
- Initialize logger
- Register completion provider
- Register webview providers
- Register commands
- Create status bar item
- Handle configuration changes

**Key Exports**:
```typescript
export function activate(context: vscode.ExtensionContext): void
export function deactivate(): void
```

### config.ts

**Purpose**: Centralized configuration management.

**Configuration Schema**:
```typescript
interface LocalCopilotConfig {
    enabled: boolean;        // Enable/disable completions
    serverUrl: string;       // Ollama server URL
    model: string;           // Model name
    maxTokens: number;       // Max tokens per completion
    temperature: number;     // Generation temperature
    debounceMs: number;      // Debounce delay
    contextLines: number;    // Lines of context
}
```

### ollamaClient.ts

**Purpose**: HTTP client for Ollama REST API.

**API Endpoints Used**:
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/tags` | GET | List available models |
| `/api/generate` | POST | Generate completions |

**Features**:
- Connection checking
- Request cancellation via AbortController
- Response cleaning
- Error handling

### completionProvider.ts

**Purpose**: Inline code completion using VS Code's InlineCompletionItemProvider.

**Prompt Formats**:
- **FIM (CodeLlama/DeepSeek)**: `<PRE> {prefix} <SUF>{suffix} <MID>`
- **General**: Comment-based prompt with file context

**Supported Languages**: All (via language-aware comment detection)

### unifiedPanel.ts

**Purpose**: Combined chat and agent webview panel.

**Features**:
- Mode switching (chat/agent)
- Model selection dropdown
- File attachment
- Conversation history
- Agent step visualization
- Approval dialogs

### agentProvider.ts

**Purpose**: Autonomous agent with tool execution capabilities.

**Available Tools**:
| Tool | Description | Requires Approval |
|------|-------------|-------------------|
| `runCommand` | Execute shell commands | ✅ Yes |
| `readFile` | Read file contents | ❌ No |
| `writeFile` | Create/overwrite files | ✅ Yes |
| `searchFiles` | Glob-based file search | ❌ No |
| `listDirectory` | List directory contents | ❌ No |

### contextManager.ts

**Purpose**: Intelligent context gathering from the workspace.

**Context Sources** (by priority):
1. Selected code (priority 10)
2. Active file (priority 9)
3. Workspace diagnostics (priority 8)
4. Open editor tabs (priority 5)

### mcpClient.ts

**Purpose**: Model Context Protocol (MCP) server integration.

**Classes**:
- `MCPServer`: Manages individual MCP server connections
- `MCPManager`: Singleton managing multiple MCP servers

**Features**:
- JSON-RPC 2.0 communication over stdio
- Tool discovery and execution
- Resource listing
- Hot-reload on configuration changes

**Configuration Schema**:
```typescript
interface MCPServerConfig {
    name: string;           // Server identifier
    command: string;        // Executable command
    args?: string[];        // Command arguments
    env?: Record<string, string>;  // Environment variables
    enabled?: boolean;      // Enable/disable server
}
```

**MCP Tools in Agent**:
MCP tools are automatically prefixed with `mcp_` and include the server name:
- `mcp_filesystem_readFile` - Read file via filesystem MCP server
- `mcp_github_searchRepositories` - Search repos via GitHub MCP server

---

## Agent System

### Tool Call Format

The agent expects LLM responses in this format:
```
\`\`\`tool
{"name": "toolName", "parameters": {"key": "value"}}
\`\`\`
```

### System Prompt Structure

```
You are Rubin, an AI coding agent...

AVAILABLE TOOLS:
- runCommand: Execute terminal commands
  - command: The command to execute
- readFile: Read file contents
  - filePath: Path to file
...

HOW TO USE A TOOL:
[Format instructions]

EXAMPLES:
[Concrete examples]

RULES:
1. Always use tools for actions
2. One tool per response
3. Wait for results before continuing
4. Summarize when done
```

### Iteration Safety

- Maximum 10 iterations per task
- Abort controller for cancellation
- User can stop at any time

---

## Security Model

### Sandboxing

1. **Path Validation**: All file operations validate paths are within workspace
2. **Approval System**: Sensitive operations require user confirmation
3. **Command Timeout**: Terminal commands have 30-second timeout
4. **No Network Access**: Agent cannot make external HTTP requests

### Sensitive Operations

Operations requiring approval:
- `runCommand` - Could execute arbitrary code
- `writeFile` - Could overwrite important files

### Webview Security

- CSP (Content Security Policy) in webview HTML
- No external script loading
- Message-based communication only

---

## Extension Points

### Adding New Tools

1. Add tool definition to `AGENT_TOOLS` array:
```typescript
{
    name: 'newTool',
    description: 'What it does',
    parameters: {
        param1: { type: 'string', description: '...', required: true }
    }
}
```

2. Add execution handler in `executeTool()`:
```typescript
case 'newTool':
    return this.executeNewTool(params, workspaceFolder);
```

3. Implement the execution method:
```typescript
private async executeNewTool(params: Record<string, string>): Promise<ToolResult> {
    // Implementation
}
```

### Adding New Commands

1. Register in `package.json`:
```json
{
    "command": "rubin.newCommand",
    "title": "Rubin: New Command"
}
```

2. Implement in `extension.ts`:
```typescript
const newCommand = vscode.commands.registerCommand('rubin.newCommand', () => {
    // Implementation
});
context.subscriptions.push(newCommand);
```

### Adding Configuration Options

1. Add to `package.json` contributes.configuration:
```json
"rubin.newOption": {
    "type": "string",
    "default": "value",
    "description": "What it does"
}
```

2. Add to `LocalCopilotConfig` interface in `config.ts`

3. Read in `getConfig()` function

---

## Performance Considerations

### Debouncing
- Inline completions debounced by 300ms (configurable)
- Prevents excessive API calls while typing

### Cancellation
- All API calls support cancellation
- Previous requests cancelled when new one starts
- User can cancel via ESC or stop button

### Memory
- Conversation history limited to last 6-10 messages
- Context manager prioritizes relevant content
- Large files truncated for context

---

## Testing

### Manual Testing
1. Press F5 to launch Extension Development Host
2. Open a code file
3. Test completions by typing
4. Test chat via sidebar
5. Test agent with simple tasks

### Debugging
1. Set breakpoints in TypeScript files
2. Check "Rubin" output channel for logs
3. Use Chrome DevTools for webview debugging

---

## Future Enhancements

- [x] Streaming responses
- [ ] Multiple conversation threads
- [x] Custom tool definitions (via MCP)
- [x] Workspace indexing
- [x] Git integration
- [x] Test generation
- [x] Documentation generation
- [x] MCP Server Integration
- [ ] Multi-modal support (images)
- [ ] Remote Ollama connections

---

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for guidelines.
