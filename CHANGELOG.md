# Changelog

All notable changes to the Rubin extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] - 2026-01-20

### Added - MCP Integration & UI Overhaul
- **MCP Server Integration** - Connect to Model Context Protocol servers for extensible tool capabilities
  - Configure servers via `rubin.mcpServers` setting
  - Auto-discovery of MCP tools on connection
  - Tools appear in Agent mode with `mcp_` prefix
  - Supports any MCP-compatible server (filesystem, GitHub, databases, etc.)
- **Manage MCP Servers** command - View connected servers, show tools, connect/disconnect
- **Refresh MCP Servers** command - Hot-reload server configurations

### Changed
- **GitHub Copilot-style UI** - Complete redesign matching Copilot Chat aesthetics
  - Centered welcome screen with tips
  - Bouncing dots loading animation
  - Modern chip-style follow-up suggestions
  - Bottom-docked input toolbar
  - Clean agent step visualization
- **Default model** changed from `codellama` to `llama3.1:8b` for better agent performance
- **Improved response cleaning** - Strips model artifacts (System:, ##, role prefixes)
- **Context persistence** - Conversation restored when panel is hidden and shown again

### Fixed
- Agent retry loop - Now stops after 2 consecutive failures of same action
- Panel visibility handling - Proper `onDidChangeVisibility` listener

## [0.6.0] - 2026-01-20

### Added - Major Feature Update
- **Streaming Responses** - Real-time token-by-token streaming in chat
- **@Mentions System** - 8 participants: @workspace, @file, @terminal, @git, @selection, @problems, @symbols, @docs
- **Follow-Up Suggestions** - Context-aware clickable suggestions after each response
- **Enhanced Agent Tools** - 14 tools including editFile, insertCode, searchCode, getSymbols, findReferences, getGitStatus, gitDiff
- **Smart Context Selection** - Intelligent gathering of imports, related files, and recent edits
- **Enhanced System Prompts** - Carefully crafted prompts for each feature
- **Embeddings Support** - Infrastructure for semantic search (requires nomic-embed-text model)

### Changed
- Major UI improvements for streaming responses with cursor animation
- Better prompt engineering for all slash commands
- Agent now supports 14 tools (up from 5)
- Improved error handling with streaming fallback

### Fixed
- Terminal processId async handling
- Unused variable warnings
- Improved type safety throughout

## [0.5.0] - 2026-01-19

### Added
- **Autonomous Agent Mode** - AI can now execute terminal commands, read/write files, and complete multi-step tasks
- **Unified Panel** - Combined chat and agent mode in a single sidebar view
- **Context Manager** - Intelligent context gathering from active files, selections, and diagnostics
- **File Attachments** - Attach current file to chat for better context
- **Model Selector** - Quick model switching directly in the chat interface
- **Approval System** - User approval required for sensitive agent actions (file writes, commands)
- **Centralized Logging** - Output channel for debugging and monitoring
- **ESLint Configuration** - Production-ready code quality standards

### Changed
- Improved system prompts for better code completions
- Enhanced error handling throughout the extension
- Better UI/UX with modern VS Code styling
- Upgraded to TypeScript strict mode

### Fixed
- Fixed escape character issues in webview HTML
- Fixed curly brace style consistency
- Fixed unused variable warnings
- Improved tool call parsing for various LLM response formats

## [0.4.3] - 2026-01-15

### Added
- Initial agent mode implementation
- Chat sidebar with conversation history

## [0.4.0] - 2026-01-10

### Added
- Basic chat functionality
- Model selection command

## [0.3.0] - 2026-01-05

### Added
- Inline code completions
- Fill-in-the-middle (FIM) support for CodeLlama

## [0.2.0] - 2025-12-20

### Added
- Status bar integration
- Configuration options

## [0.1.0] - 2025-12-15

### Added
- Initial release
- Basic Ollama integration
- Simple code completion
