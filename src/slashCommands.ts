import * as vscode from 'vscode';

/**
 * Slash command definition
 */
export interface SlashCommand {
    name: string;
    description: string;
    usage: string;
    handler: (args: string, context: CommandContext) => Promise<string>;
}

/**
 * Context passed to slash command handlers
 */
export interface CommandContext {
    selectedCode?: string;
    activeFile?: {
        content: string;
        language: string;
        fileName: string;
    };
    workspaceFolder?: string;
}

/**
 * Builds context from the current editor state
 */
export async function buildCommandContext(): Promise<CommandContext> {
    const context: CommandContext = {};

    const editor = vscode.window.activeTextEditor;
    if (editor) {
        const selection = editor.selection;
        if (!selection.isEmpty) {
            context.selectedCode = editor.document.getText(selection);
        }

        context.activeFile = {
            content: editor.document.getText(),
            language: editor.document.languageId,
            fileName: editor.document.fileName.split('/').pop() || 'file',
        };
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
        context.workspaceFolder = workspaceFolder.uri.fsPath;
    }

    return context;
}

/**
 * All available slash commands
 */
export const SLASH_COMMANDS: SlashCommand[] = [
    {
        name: 'explain',
        description: 'Explain how the selected code works',
        usage: '/explain [optional: specific aspect to focus on]',
        handler: async (args, context) => {
            const code = context.selectedCode || context.activeFile?.content;
            if (!code) {
                return 'Please select some code or open a file to explain.';
            }
            const focus = args ? `Focus on: ${args}` : '';
            return `Please explain this code in detail. ${focus}

\`\`\`${context.activeFile?.language || ''}
${code}
\`\`\`

Provide:
1. A high-level overview of what the code does
2. Step-by-step explanation of the logic
3. Key concepts and patterns used
4. Any potential issues or improvements`;
        },
    },
    {
        name: 'fix',
        description: 'Fix problems in the selected code',
        usage: '/fix [optional: describe the problem]',
        handler: async (args, context) => {
            const code = context.selectedCode || context.activeFile?.content;
            if (!code) {
                return 'Please select some code to fix.';
            }
            const problem = args ? `The reported problem is: ${args}` : '';
            return `Fix the issues in this code. ${problem}

\`\`\`${context.activeFile?.language || ''}
${code}
\`\`\`

Provide the corrected code with explanations of what was wrong and how you fixed it.`;
        },
    },
    {
        name: 'tests',
        description: 'Generate unit tests for the selected code',
        usage: '/tests [optional: testing framework like jest, mocha, pytest]',
        handler: async (args, context) => {
            const code = context.selectedCode || context.activeFile?.content;
            if (!code) {
                return 'Please select code to generate tests for.';
            }
            const framework = args || 'appropriate testing framework';
            return `Generate comprehensive unit tests for this code using ${framework}.

\`\`\`${context.activeFile?.language || ''}
${code}
\`\`\`

Include:
1. Tests for normal/expected behavior
2. Edge cases and boundary conditions
3. Error handling scenarios
4. Mock any external dependencies`;
        },
    },
    {
        name: 'doc',
        description: 'Generate documentation for the selected code',
        usage: '/doc [optional: documentation style like JSDoc, docstring]',
        handler: async (args, context) => {
            const code = context.selectedCode || context.activeFile?.content;
            if (!code) {
                return 'Please select code to document.';
            }
            const style = args || 'appropriate documentation format';
            return `Generate comprehensive documentation for this code using ${style}.

\`\`\`${context.activeFile?.language || ''}
${code}
\`\`\`

Include:
1. Description of purpose and functionality
2. Parameter descriptions with types
3. Return value description
4. Usage examples
5. Any important notes or caveats`;
        },
    },
    {
        name: 'optimize',
        description: 'Optimize the selected code for performance',
        usage: '/optimize [optional: optimization focus like speed, memory, readability]',
        handler: async (args, context) => {
            const code = context.selectedCode || context.activeFile?.content;
            if (!code) {
                return 'Please select code to optimize.';
            }
            const focus = args || 'overall performance and readability';
            return `Optimize this code for ${focus}.

\`\`\`${context.activeFile?.language || ''}
${code}
\`\`\`

Provide:
1. The optimized code
2. Explanation of each optimization
3. Performance impact analysis
4. Trade-offs considered`;
        },
    },
    {
        name: 'refactor',
        description: 'Refactor the selected code following best practices',
        usage: '/refactor [optional: specific pattern or goal]',
        handler: async (args, context) => {
            const code = context.selectedCode || context.activeFile?.content;
            if (!code) {
                return 'Please select code to refactor.';
            }
            const goal = args || 'clean code principles and best practices';
            return `Refactor this code following ${goal}.

\`\`\`${context.activeFile?.language || ''}
${code}
\`\`\`

Apply:
1. SOLID principles where applicable
2. DRY (Don't Repeat Yourself)
3. Clear naming conventions
4. Proper separation of concerns
5. Design patterns if appropriate`;
        },
    },
    {
        name: 'review',
        description: 'Review code and provide feedback',
        usage: '/review',
        handler: async (_args, context) => {
            const code = context.selectedCode || context.activeFile?.content;
            if (!code) {
                return 'Please select code to review.';
            }
            return `Perform a thorough code review on this code.

\`\`\`${context.activeFile?.language || ''}
${code}
\`\`\`

Evaluate:
1. **Correctness**: Logic errors, bugs, edge cases
2. **Security**: Vulnerabilities, injection risks, data exposure
3. **Performance**: Inefficiencies, unnecessary operations
4. **Maintainability**: Readability, complexity, documentation
5. **Best Practices**: Language idioms, conventions, patterns

Rate each category (Good/Needs Improvement/Critical) and provide specific suggestions.`;
        },
    },
    {
        name: 'simplify',
        description: 'Simplify complex code',
        usage: '/simplify',
        handler: async (_args, context) => {
            const code = context.selectedCode || context.activeFile?.content;
            if (!code) {
                return 'Please select code to simplify.';
            }
            return `Simplify this code while maintaining the same functionality.

\`\`\`${context.activeFile?.language || ''}
${code}
\`\`\`

Goals:
1. Reduce complexity and nesting
2. Use built-in functions where possible
3. Improve readability
4. Remove redundant code`;
        },
    },
    {
        name: 'convert',
        description: 'Convert code to a different language or format',
        usage: '/convert <target language or format>',
        handler: async (args, context) => {
            const code = context.selectedCode || context.activeFile?.content;
            if (!code) {
                return 'Please select code to convert.';
            }
            if (!args) {
                return 'Please specify the target language. Usage: /convert python';
            }
            return `Convert this ${context.activeFile?.language || ''} code to ${args}.

\`\`\`${context.activeFile?.language || ''}
${code}
\`\`\`

Ensure:
1. Idiomatic ${args} code
2. Equivalent functionality
3. Proper error handling for the target language
4. Appropriate data structures`;
        },
    },
    {
        name: 'commit',
        description: 'Generate a commit message for staged changes',
        usage: '/commit [optional: type like feat, fix, docs]',
        handler: async (args, _context) => {
            const type = args || '';
            return `Generate a conventional commit message${type ? ` of type "${type}"` : ''} for the current staged changes.

Use the Conventional Commits format:
- feat: A new feature
- fix: A bug fix
- docs: Documentation changes
- style: Code style changes (formatting)
- refactor: Code refactoring
- perf: Performance improvements
- test: Adding tests
- chore: Maintenance tasks

The message should be:
1. Concise but descriptive
2. Written in imperative mood
3. Include scope if applicable
4. Have a body explaining "why" if needed`;
        },
    },
    {
        name: 'terminal',
        description: 'Suggest terminal commands for a task',
        usage: '/terminal <what you want to do>',
        handler: async (args, context) => {
            if (!args) {
                return 'Please describe what you want to do. Usage: /terminal install react dependencies';
            }
            const workspaceInfo = context.workspaceFolder 
                ? `Working directory: ${context.workspaceFolder}`
                : '';
            return `Suggest terminal commands to: ${args}

${workspaceInfo}

Provide:
1. The exact commands to run
2. Explanation of each command
3. Any prerequisites
4. Expected output`;
        },
    },
    {
        name: 'help',
        description: 'Show available slash commands',
        usage: '/help',
        handler: async () => {
            const commandList = SLASH_COMMANDS.map(cmd => 
                `**/${cmd.name}** - ${cmd.description}\n   Usage: \`${cmd.usage}\``
            ).join('\n\n');
            return `# Available Slash Commands\n\n${commandList}`;
        },
    },
];

/**
 * Parse a message for slash commands
 */
export function parseSlashCommand(message: string): { command: SlashCommand | null; args: string } {
    const trimmed = message.trim();
    
    if (!trimmed.startsWith('/')) {
        return { command: null, args: message };
    }

    const spaceIndex = trimmed.indexOf(' ');
    const commandName = spaceIndex === -1 
        ? trimmed.slice(1) 
        : trimmed.slice(1, spaceIndex);
    const args = spaceIndex === -1 
        ? '' 
        : trimmed.slice(spaceIndex + 1).trim();

    const command = SLASH_COMMANDS.find(c => c.name.toLowerCase() === commandName.toLowerCase());
    
    return { command: command || null, args };
}

/**
 * Get command suggestions for autocomplete
 */
export function getCommandSuggestions(prefix: string): SlashCommand[] {
    if (!prefix.startsWith('/')) {
        return [];
    }
    
    const search = prefix.slice(1).toLowerCase();
    return SLASH_COMMANDS.filter(cmd => 
        cmd.name.toLowerCase().startsWith(search)
    );
}
