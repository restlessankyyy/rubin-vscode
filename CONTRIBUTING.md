# Contributing to Rubin

First off, thank you for considering contributing to Rubin! It's people like you that make Rubin such a great tool.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Making Changes](#making-changes)
- [Testing](#testing)
- [Pull Request Process](#pull-request-process)
- [Coding Standards](#coding-standards)

## Code of Conduct

This project and everyone participating in it is governed by our commitment to providing a welcoming and inspiring community. Please be respectful and constructive in all interactions.

## Getting Started

### Prerequisites

- Node.js 18+ 
- VS Code 1.80+
- Ollama installed and running
- Git

### Quick Start

```bash
# Clone the repository
git clone https://github.com/restlessankyyy/rubin-vscode.git
cd rubin-vscode

# Install dependencies
npm install

# Compile the extension
npm run compile

# Open in VS Code
code .

# Press F5 to launch Extension Development Host
```

## Development Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Compile in Watch Mode

```bash
npm run watch
```

This will automatically recompile when you make changes.

### 3. Launch Extension

Press `F5` in VS Code to launch the Extension Development Host.

### 4. Debug

Set breakpoints in your TypeScript files and they will be hit in the Extension Development Host.

## Project Structure

```
rubin-vscode/
├── src/
│   ├── extension.ts          # Entry point
│   ├── config.ts             # Configuration management
│   ├── logger.ts             # Logging utility
│   ├── ollamaClient.ts       # Ollama API client
│   ├── completionProvider.ts # Inline completions
│   ├── unifiedPanel.ts       # Chat + Agent webview
│   ├── agentProvider.ts      # Agent logic & tools
│   ├── contextManager.ts     # Context gathering
│   ├── slashCommands.ts      # Slash command handlers
│   ├── codeActions.ts        # Code action provider
│   ├── inlineChat.ts         # Inline editing
│   ├── gitIntegration.ts     # Git features
│   └── workspaceIndexer.ts   # Workspace indexing
├── docs/
│   └── ARCHITECTURE.md       # Architecture documentation
├── package.json              # Extension manifest
├── tsconfig.json             # TypeScript config
└── README.md                 # User documentation
```

## Making Changes

### Branch Naming

- `feat/description` - New features
- `fix/description` - Bug fixes
- `docs/description` - Documentation
- `refactor/description` - Code refactoring

### Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): description

[optional body]
```

Types:
- `feat` - New feature
- `fix` - Bug fix
- `docs` - Documentation
- `style` - Code style (formatting)
- `refactor` - Code refactoring
- `perf` - Performance improvement
- `test` - Adding tests
- `chore` - Maintenance

Examples:
```
feat(agent): add file search tool
fix(completions): handle empty responses
docs(readme): add troubleshooting section
```

## Testing

### Manual Testing

1. Press F5 to launch Extension Development Host
2. Open a code file
3. Test features:
   - Type to trigger inline completions
   - Open Rubin panel (Cmd+Shift+R)
   - Try slash commands (/explain, /fix, etc.)
   - Test agent mode with simple tasks
   - Right-click selected code for code actions

### Checking Output

1. Open the Output panel (View → Output)
2. Select "Rubin" from the dropdown
3. Review logs for errors or warnings

### Linting

```bash
npm run lint
```

### Building

```bash
npm run compile
```

## Pull Request Process

1. **Fork** the repository
2. **Create** a feature branch from `main`
3. **Make** your changes
4. **Ensure** lint and compile pass:
   ```bash
   npm run lint && npm run compile
   ```
5. **Commit** with a descriptive message
6. **Push** to your fork
7. **Open** a Pull Request

### PR Checklist

- [ ] Code compiles without errors
- [ ] ESLint passes
- [ ] Commit messages follow conventions
- [ ] Documentation updated if needed
- [ ] Tested manually in Extension Development Host

## Coding Standards

### TypeScript

- Use TypeScript strict mode
- Prefer `const` over `let`
- Use async/await over raw Promises
- Add types to function parameters and returns
- Use interfaces for object shapes

### Code Style

- Use curly braces for all control structures
- Use 4-space indentation
- Add JSDoc comments for public functions
- Keep functions focused and small
- Use meaningful variable names

### Error Handling

- Always catch errors appropriately
- Log errors with context using the logger
- Show user-friendly error messages
- Never swallow errors silently

### Example

```typescript
/**
 * Process a user request and return a response.
 * @param request - The user's input request
 * @returns The generated response or null if failed
 */
async function processRequest(request: string): Promise<string | null> {
    try {
        const result = await someAsyncOperation(request);
        
        if (!result) {
            logger.warn('Empty result for request', { request });
            return null;
        }
        
        return result;
    } catch (error) {
        logger.error('Failed to process request', error);
        return null;
    }
}
```

## Adding New Features

### Adding a Slash Command

1. Edit `src/slashCommands.ts`
2. Add a new entry to `SLASH_COMMANDS` array:

```typescript
{
    name: 'mycommand',
    description: 'What it does',
    usage: '/mycommand [args]',
    handler: async (args, context) => {
        // Return the prompt to send to the LLM
        return `Your prompt here with ${args}`;
    },
},
```

### Adding an Agent Tool

1. Edit `src/agentProvider.ts`
2. Add tool definition to `AGENT_TOOLS`
3. Add case in `executeTool()` switch
4. Implement the execution method

### Adding a Code Action

1. Edit `src/codeActions.ts`
2. Add to `provideCodeActions()` method
3. Register command in `registerCodeActionCommands()`
4. Add command to `package.json`

## Questions?

Feel free to open an issue for:
- Bug reports
- Feature requests
- Questions about the codebase

Thank you for contributing! 🎉
