import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { getConfig } from './config';
import { getOllamaClient } from './ollamaClient';

// Tool definitions that the AI can call
export interface AgentTool {
    name: string;
    description: string;
    parameters: Record<string, { type: string; description: string; required?: boolean }>;
}

export interface ToolCall {
    name: string;
    parameters: Record<string, string>;
}

export interface ToolResult {
    success: boolean;
    output: string;
    error?: string;
}

export interface AgentStep {
    type: 'thinking' | 'tool_call' | 'tool_result' | 'response' | 'approval_requested';
    content: string;
    toolName?: string;
    toolParams?: Record<string, string>;
    result?: ToolResult;
    timestamp: Date;
}

export type AgentEventCallback = (step: AgentStep) => void;

// Available tools for the agent
const AGENT_TOOLS: AgentTool[] = [
    {
        name: 'runCommand',
        description: 'Execute a terminal command in the workspace. Use for running scripts, installing packages, or executing any shell command.',
        parameters: {
            command: { type: 'string', description: 'The command to execute', required: true },
        },
    },
    {
        name: 'readFile',
        description: 'Read the contents of a file in the workspace.',
        parameters: {
            filePath: { type: 'string', description: 'Relative path to the file from workspace root', required: true },
        },
    },
    {
        name: 'writeFile',
        description: 'Create or overwrite a file with new content.',
        parameters: {
            filePath: { type: 'string', description: 'Relative path to the file from workspace root', required: true },
            content: { type: 'string', description: 'The content to write to the file', required: true },
        },
    },
    {
        name: 'editFile',
        description: 'Edit specific lines in a file. Better than writeFile for making targeted changes.',
        parameters: {
            filePath: { type: 'string', description: 'Relative path to the file', required: true },
            startLine: { type: 'number', description: 'Starting line number (1-based)', required: true },
            endLine: { type: 'number', description: 'Ending line number (1-based, inclusive)', required: true },
            newContent: { type: 'string', description: 'New content to replace the specified lines', required: true },
        },
    },
    {
        name: 'insertCode',
        description: 'Insert code at a specific line in a file without replacing existing content.',
        parameters: {
            filePath: { type: 'string', description: 'Relative path to the file', required: true },
            lineNumber: { type: 'number', description: 'Line number to insert at (1-based)', required: true },
            content: { type: 'string', description: 'Content to insert', required: true },
        },
    },
    {
        name: 'searchFiles',
        description: 'Search for files in the workspace by name pattern.',
        parameters: {
            pattern: { type: 'string', description: 'Glob pattern to search (e.g., "**/*.ts" for all TypeScript files)', required: true },
        },
    },
    {
        name: 'searchCode',
        description: 'Search for text or regex patterns across all files in the workspace.',
        parameters: {
            query: { type: 'string', description: 'Text or regex pattern to search for', required: true },
            filePattern: { type: 'string', description: 'Optional glob pattern to filter files (e.g., "**/*.ts")', required: false },
        },
    },
    {
        name: 'listDirectory',
        description: 'List files and folders in a directory.',
        parameters: {
            dirPath: { type: 'string', description: 'Relative path to the directory from workspace root (use "." for root)', required: true },
        },
    },
    {
        name: 'getSymbols',
        description: 'Get all symbols (functions, classes, variables) defined in a file.',
        parameters: {
            filePath: { type: 'string', description: 'Relative path to the file', required: true },
        },
    },
    {
        name: 'findReferences',
        description: 'Find all references to a symbol across the workspace.',
        parameters: {
            filePath: { type: 'string', description: 'File where the symbol is defined', required: true },
            symbolName: { type: 'string', description: 'Name of the symbol to find references for', required: true },
            line: { type: 'number', description: 'Line number where the symbol is located', required: true },
        },
    },
    {
        name: 'createDirectory',
        description: 'Create a new directory (and parent directories if needed).',
        parameters: {
            dirPath: { type: 'string', description: 'Relative path to the directory to create', required: true },
        },
    },
    {
        name: 'deleteFile',
        description: 'Delete a file or directory from the workspace.',
        parameters: {
            filePath: { type: 'string', description: 'Relative path to the file or directory to delete', required: true },
        },
    },
    {
        name: 'getGitStatus',
        description: 'Get the current git status showing modified, staged, and untracked files.',
        parameters: {},
    },
    {
        name: 'gitDiff',
        description: 'Get the git diff for a specific file or all changes.',
        parameters: {
            filePath: { type: 'string', description: 'Optional file path to get diff for. Omit for all changes.', required: false },
        },
    },
];

export class AgentProvider {
    private isRunning: boolean = false;
    private abortController: AbortController | null = null;
    private conversationHistory: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];
    private eventCallback: AgentEventCallback | null = null;

    // Approval mechanism
    private pendingApprovalResolve: ((allowed: boolean) => void) | null = null;
    private isWaitingForApproval: boolean = false;

    constructor() { }

    setEventCallback(callback: AgentEventCallback): void {
        this.eventCallback = callback;
    }

    approveRequest(): void {
        if (this.pendingApprovalResolve) {
            this.pendingApprovalResolve(true);
            this.pendingApprovalResolve = null;
            this.isWaitingForApproval = false;
        }
    }

    rejectRequest(): void {
        if (this.pendingApprovalResolve) {
            this.pendingApprovalResolve(false);
            this.pendingApprovalResolve = null;
            this.isWaitingForApproval = false;
        }
    }

    private emitStep(step: AgentStep): void {
        if (this.eventCallback) {
            this.eventCallback(step);
        }
    }

    isAgentRunning(): boolean {
        return this.isRunning;
    }

    stop(): void {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        this.isRunning = false;
    }

    clearHistory(): void {
        this.conversationHistory = [];
    }

    async runTask(task: string): Promise<string> {
        if (this.isRunning) {
            throw new Error('Agent is already running a task');
        }

        this.isRunning = true;
        this.abortController = new AbortController();

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceFolder) {
            this.isRunning = false;
            throw new Error('No workspace folder open');
        }

        try {
            // Build the system prompt with tool definitions
            const systemPrompt = this.buildSystemPrompt();

            // Add user task to history
            this.conversationHistory.push({ role: 'user', content: task });

            let finalResponse = '';
            let iterations = 0;
            const maxIterations = 10; // Safety limit

            while (iterations < maxIterations && this.isRunning) {
                iterations++;

                this.emitStep({
                    type: 'thinking',
                    content: `Iteration ${iterations}: Processing...`,
                    timestamp: new Date(),
                });

                // Generate AI response
                const response = await this.generateResponse(systemPrompt);

                if (!this.isRunning) {
                    break; // Check if stopped
                }

                if (!response) {
                    finalResponse = 'Failed to get response from the model.';
                    break;
                }

                // Parse the response for tool calls
                const toolCall = this.parseToolCall(response);

                if (toolCall) {
                    this.emitStep({
                        type: 'tool_call',
                        content: `Calling tool: ${toolCall.name}`,
                        toolName: toolCall.name,
                        toolParams: toolCall.parameters,
                        timestamp: new Date(),
                    });

                    // Execute the tool
                    const result = await this.executeTool(toolCall, workspaceFolder);

                    this.emitStep({
                        type: 'tool_result',
                        content: result.output,
                        toolName: toolCall.name,
                        result: result,
                        timestamp: new Date(),
                    });

                    // Add tool call and result to history
                    this.conversationHistory.push({
                        role: 'assistant',
                        content: `[TOOL_CALL: ${toolCall.name}]\n${JSON.stringify(toolCall.parameters)}`
                    });
                    this.conversationHistory.push({
                        role: 'system',
                        content: `[TOOL_RESULT]\n${result.success ? result.output : `Error: ${result.error}`}`
                    });
                } else {
                    // No tool call - this is the final response
                    // Clean up any raw tool markers the model might include
                    finalResponse = this.cleanFinalResponse(response);
                    this.conversationHistory.push({ role: 'assistant', content: finalResponse });

                    this.emitStep({
                        type: 'response',
                        content: finalResponse,
                        timestamp: new Date(),
                    });
                    break;
                }
            }

            if (iterations >= maxIterations) {
                finalResponse = 'Agent reached maximum iterations. Task may be incomplete.';
            }

            return finalResponse;
        } finally {
            this.isRunning = false;
            this.abortController = null;
        }
    }

    private buildSystemPrompt(): string {
        const toolDescriptions = AGENT_TOOLS.map(tool => {
            const params = Object.entries(tool.parameters)
                .map(([name, info]) => `  - ${name}: ${info.description}`)
                .join('\n');
            return `- ${tool.name}: ${tool.description}\n${params}`;
        }).join('\n\n');

        return `You are Rubin, an AI coding agent. You MUST use tools to complete tasks. You cannot just talk - you must take action.

AVAILABLE TOOLS:
${toolDescriptions}

HOW TO USE A TOOL:
When you need to perform an action, output EXACTLY this format:

\`\`\`tool
{"name": "TOOL_NAME", "parameters": {"param": "value"}}
\`\`\`

EXAMPLES:

To create a file:
\`\`\`tool
{"name": "writeFile", "parameters": {"filePath": "hello.ts", "content": "export const hello = () => 'Hello World';"}}
\`\`\`

To run a command (executes in workspace root):
\`\`\`tool
{"name": "runCommand", "parameters": {"command": "npm install"}}
\`\`\`
(NEVER use 'cd'. You are already in the workspace root.)

To read a file:
\`\`\`tool
{"name": "readFile", "parameters": {"filePath": "package.json"}}
\`\`\`

RULES:
1. ALWAYS use a tool when asked to do something. Never just describe what you would do.
2. Use ONE tool per response.
3. After each tool result, decide if you need another tool or if the task is done.
4. When the task is complete, give a brief summary WITHOUT using any tool.

START NOW - analyze the request and use the appropriate tool.`;
    }

    private async generateResponse(systemPrompt: string): Promise<string | null> {
        const config = getConfig();
        const client = getOllamaClient(config.serverUrl);

        // Build the full prompt
        let prompt = systemPrompt + '\n\n';

        for (const msg of this.conversationHistory.slice(-10)) { // Keep last 10 messages
            if (msg.role === 'user') {
                prompt += `User: ${msg.content}\n\n`;
            } else if (msg.role === 'assistant') {
                prompt += `Assistant: ${msg.content}\n\n`;
            } else if (msg.role === 'system') {
                prompt += `System: ${msg.content}\n\n`;
            }
        }

        prompt += 'Assistant:';

        try {
            const response = await client.generateChat(prompt, {
                ...config,
                maxTokens: 2048, // More tokens for agent responses
                temperature: 0.3, // More focused responses
            });
            return response;
        } catch (error) {
            console.error('Agent generation error:', error);
            return null;
        }
    }

    private cleanFinalResponse(response: string): string {
        // Remove raw tool markers that some models include in their final response
        let cleaned = response;

        // Remove **TOOL_CALL** / **TOOL_RESULT** blocks
        cleaned = cleaned.replace(/\*\*TOOL_CALL:?\s*\w*\*\*[\s\S]*?(?=\n\n|\*\*|$)/gi, '');
        cleaned = cleaned.replace(/\*\*TOOL_RESULT\*\*[\s\S]*?(?=\n\n|\*\*|$)/gi, '');

        // Remove ```tool blocks
        cleaned = cleaned.replace(/```tool[\s\S]*?```/g, '');

        // Remove [TOOL_CALL] / [TOOL_RESULT] markers
        cleaned = cleaned.replace(/\[TOOL_CALL:?\s*\w*\][\s\S]*?(?=\n\n|\[|$)/gi, '');
        cleaned = cleaned.replace(/\[TOOL_RESULT\][\s\S]*?(?=\n\n|\[|$)/gi, '');

        // Remove </start_of_turn> and similar model artifacts
        cleaned = cleaned.replace(/<\/?\w+_of_\w+>/g, '');

        // Clean up extra whitespace
        cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

        // If everything was stripped, provide a default message
        if (!cleaned || cleaned.length < 5) {
            cleaned = '✅ Done!';
        }

        return cleaned;
    }

    private parseToolCall(response: string): ToolCall | null {
        // Try multiple formats since different models output differently

        // 1. Try ```tool wrapped format
        const toolMatch = response.match(/```tool\s*\n?([\s\S]*?)\n?```/);
        if (toolMatch) {
            try {
                const toolJson = JSON.parse(toolMatch[1].trim());
                if (toolJson.name && typeof toolJson.name === 'string') {
                    return {
                        name: toolJson.name,
                        parameters: toolJson.parameters || {},
                    };
                }
            } catch (e) {
                console.error('Failed to parse wrapped tool call:', e);
            }
        }

        // 2. Try raw JSON format (model outputs JSON directly)
        const jsonMatch = response.match(/\{"name":\s*"(\w+)",\s*"parameters":\s*(\{[^}]+\})\}/);
        if (jsonMatch) {
            try {
                const fullMatch = jsonMatch[0];
                const toolJson = JSON.parse(fullMatch);
                if (toolJson.name && typeof toolJson.name === 'string') {
                    return {
                        name: toolJson.name,
                        parameters: toolJson.parameters || {},
                    };
                }
            } catch (e) {
                console.error('Failed to parse raw JSON tool call:', e);
            }
        }

        // 3. Try to find any valid JSON object with name and parameters
        const anyJsonMatch = response.match(/\{[\s\S]*?"name"[\s\S]*?"parameters"[\s\S]*?\}/);
        if (anyJsonMatch) {
            try {
                // Clean up any trailing garbage (like </start_of_turn>)
                let jsonStr = anyJsonMatch[0];
                // Find the matching closing brace
                let braceCount = 0;
                let endIndex = 0;
                for (let i = 0; i < jsonStr.length; i++) {
                    if (jsonStr[i] === '{') {
                        braceCount++;
                    }
                    if (jsonStr[i] === '}') {
                        braceCount--;
                    }
                    if (braceCount === 0) {
                        endIndex = i + 1;
                        break;
                    }
                }
                jsonStr = jsonStr.substring(0, endIndex);

                const toolJson = JSON.parse(jsonStr);
                if (toolJson.name && typeof toolJson.name === 'string') {
                    return {
                        name: toolJson.name,
                        parameters: toolJson.parameters || {},
                    };
                }
            } catch (e) {
                console.error('Failed to parse any JSON tool call:', e);
            }
        }

        return null;
    }

    private async executeTool(toolCall: ToolCall, workspaceFolder: string): Promise<ToolResult> {
        // Sensitive tools require approval
        if (toolCall.name === 'runCommand' || toolCall.name === 'writeFile' || toolCall.name === 'editFile' || toolCall.name === 'deleteFile' || toolCall.name === 'insertCode') {
            this.isWaitingForApproval = true;
            this.emitStep({
                type: 'approval_requested',
                content: `Requesting approval to use ${toolCall.name}`,
                toolName: toolCall.name,
                toolParams: toolCall.parameters,
                timestamp: new Date()
            });

            // Wait for approval
            const allowed = await new Promise<boolean>((resolve) => {
                this.pendingApprovalResolve = resolve;
            });

            if (!allowed) {
                return { success: false, output: '', error: 'User denied the action.' };
            }
        }

        switch (toolCall.name) {
            case 'runCommand':
                return this.executeRunCommand(toolCall.parameters.command, workspaceFolder);
            case 'readFile':
                return this.executeReadFile(toolCall.parameters.filePath, workspaceFolder);
            case 'writeFile':
                return this.executeWriteFile(
                    toolCall.parameters.filePath,
                    toolCall.parameters.content,
                    workspaceFolder
                );
            case 'editFile':
                return this.executeEditFile(
                    toolCall.parameters.filePath,
                    parseInt(toolCall.parameters.startLine),
                    parseInt(toolCall.parameters.endLine),
                    toolCall.parameters.newContent,
                    workspaceFolder
                );
            case 'insertCode':
                return this.executeInsertCode(
                    toolCall.parameters.filePath,
                    parseInt(toolCall.parameters.lineNumber),
                    toolCall.parameters.content,
                    workspaceFolder
                );
            case 'searchFiles':
                return this.executeSearchFiles(toolCall.parameters.pattern, workspaceFolder);
            case 'searchCode':
                return this.executeSearchCode(
                    toolCall.parameters.query,
                    toolCall.parameters.filePattern,
                    workspaceFolder
                );
            case 'listDirectory':
                return this.executeListDirectory(toolCall.parameters.dirPath, workspaceFolder);
            case 'getSymbols':
                return this.executeGetSymbols(toolCall.parameters.filePath, workspaceFolder);
            case 'findReferences':
                return this.executeFindReferences(
                    toolCall.parameters.filePath,
                    toolCall.parameters.symbolName,
                    parseInt(toolCall.parameters.line),
                    workspaceFolder
                );
            case 'createDirectory':
                return this.executeCreateDirectory(toolCall.parameters.dirPath, workspaceFolder);
            case 'deleteFile':
                return this.executeDeleteFile(toolCall.parameters.filePath, workspaceFolder);
            case 'getGitStatus':
                return this.executeGitStatus(workspaceFolder);
            case 'gitDiff':
                return this.executeGitDiff(toolCall.parameters.filePath, workspaceFolder);
            default:
                return { success: false, output: '', error: `Unknown tool: ${toolCall.name}` };
        }
    }

    private async executeRunCommand(command: string, cwd: string): Promise<ToolResult> {
        return new Promise((resolve) => {
            const timeout = 30000; // 30 second timeout

            cp.exec(command, { cwd, timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
                if (error) {
                    resolve({
                        success: false,
                        output: stdout || '',
                        error: stderr || error.message,
                    });
                } else {
                    resolve({
                        success: true,
                        output: stdout + (stderr ? `\nStderr: ${stderr}` : ''),
                    });
                }
            });
        });
    }

    private async executeReadFile(filePath: string, workspaceFolder: string): Promise<ToolResult> {
        try {
            const fullPath = path.join(workspaceFolder, filePath);

            // Security check: ensure path is within workspace
            if (!fullPath.startsWith(workspaceFolder)) {
                return { success: false, output: '', error: 'Path is outside workspace' };
            }

            if (!fs.existsSync(fullPath)) {
                return { success: false, output: '', error: 'File does not exist' };
            }

            const content = fs.readFileSync(fullPath, 'utf-8');
            return { success: true, output: content };
        } catch (error) {
            return {
                success: false,
                output: '',
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    private async executeWriteFile(
        filePath: string,
        content: string,
        workspaceFolder: string
    ): Promise<ToolResult> {
        try {
            const fullPath = path.join(workspaceFolder, filePath);

            // Security check
            if (!fullPath.startsWith(workspaceFolder)) {
                return { success: false, output: '', error: 'Path is outside workspace' };
            }

            // Create directory if needed
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            fs.writeFileSync(fullPath, content, 'utf-8');

            // Open the file in editor
            const doc = await vscode.workspace.openTextDocument(fullPath);
            await vscode.window.showTextDocument(doc, { preview: false });

            return { success: true, output: `File written successfully: ${filePath}` };
        } catch (error) {
            return {
                success: false,
                output: '',
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    private async executeSearchFiles(pattern: string, workspaceFolder: string): Promise<ToolResult> {
        try {
            const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 50);
            const relativePaths = files.map(f => path.relative(workspaceFolder, f.fsPath));

            if (relativePaths.length === 0) {
                return { success: true, output: 'No files found matching the pattern.' };
            }

            return {
                success: true,
                output: `Found ${relativePaths.length} files:\n${relativePaths.join('\n')}`
            };
        } catch (error) {
            return {
                success: false,
                output: '',
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    private async executeListDirectory(dirPath: string, workspaceFolder: string): Promise<ToolResult> {
        try {
            const fullPath = path.join(workspaceFolder, dirPath);

            if (!fullPath.startsWith(workspaceFolder)) {
                return { success: false, output: '', error: 'Path is outside workspace' };
            }

            if (!fs.existsSync(fullPath)) {
                return { success: false, output: '', error: 'Directory does not exist' };
            }

            const entries = fs.readdirSync(fullPath, { withFileTypes: true });
            const formatted = entries.map(entry => {
                const prefix = entry.isDirectory() ? '📁 ' : '📄 ';
                return prefix + entry.name;
            });

            return {
                success: true,
                output: `Contents of ${dirPath}:\n${formatted.join('\n')}`
            };
        } catch (error) {
            return {
                success: false,
                output: '',
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    private async executeEditFile(
        filePath: string,
        startLine: number,
        endLine: number,
        newContent: string,
        workspaceFolder: string
    ): Promise<ToolResult> {
        try {
            const fullPath = path.join(workspaceFolder, filePath);

            if (!fullPath.startsWith(workspaceFolder)) {
                return { success: false, output: '', error: 'Path is outside workspace' };
            }

            if (!fs.existsSync(fullPath)) {
                return { success: false, output: '', error: 'File does not exist' };
            }

            const content = fs.readFileSync(fullPath, 'utf-8');
            const lines = content.split('\n');

            if (startLine < 1 || endLine > lines.length || startLine > endLine) {
                return { success: false, output: '', error: `Invalid line range. File has ${lines.length} lines.` };
            }

            // Replace the specified lines
            const newLines = newContent.split('\n');
            lines.splice(startLine - 1, endLine - startLine + 1, ...newLines);

            fs.writeFileSync(fullPath, lines.join('\n'), 'utf-8');

            // Open the file at the edited location
            const doc = await vscode.workspace.openTextDocument(fullPath);
            await vscode.window.showTextDocument(doc, { preview: false });

            return { success: true, output: `Edited lines ${startLine}-${endLine} in ${filePath}` };
        } catch (error) {
            return {
                success: false,
                output: '',
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    private async executeInsertCode(
        filePath: string,
        lineNumber: number,
        content: string,
        workspaceFolder: string
    ): Promise<ToolResult> {
        try {
            const fullPath = path.join(workspaceFolder, filePath);

            if (!fullPath.startsWith(workspaceFolder)) {
                return { success: false, output: '', error: 'Path is outside workspace' };
            }

            if (!fs.existsSync(fullPath)) {
                return { success: false, output: '', error: 'File does not exist' };
            }

            const fileContent = fs.readFileSync(fullPath, 'utf-8');
            const lines = fileContent.split('\n');

            if (lineNumber < 1 || lineNumber > lines.length + 1) {
                return { success: false, output: '', error: `Invalid line number. File has ${lines.length} lines.` };
            }

            // Insert at the specified line
            const newLines = content.split('\n');
            lines.splice(lineNumber - 1, 0, ...newLines);

            fs.writeFileSync(fullPath, lines.join('\n'), 'utf-8');

            const doc = await vscode.workspace.openTextDocument(fullPath);
            await vscode.window.showTextDocument(doc, { preview: false });

            return { success: true, output: `Inserted ${newLines.length} lines at line ${lineNumber} in ${filePath}` };
        } catch (error) {
            return {
                success: false,
                output: '',
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    private async executeSearchCode(
        query: string,
        filePattern: string | undefined,
        workspaceFolder: string
    ): Promise<ToolResult> {
        try {
            const pattern = filePattern || '**/*';
            const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 100);
            const results: string[] = [];
            const maxResultsPerFile = 5;
            const maxTotalResults = 30;

            for (const file of files) {
                if (results.length >= maxTotalResults) { break; }

                try {
                    const content = fs.readFileSync(file.fsPath, 'utf-8');
                    const lines = content.split('\n');
                    let fileResultCount = 0;

                    for (let i = 0; i < lines.length && fileResultCount < maxResultsPerFile; i++) {
                        if (lines[i].toLowerCase().includes(query.toLowerCase())) {
                            const relativePath = path.relative(workspaceFolder, file.fsPath);
                            results.push(`${relativePath}:${i + 1}: ${lines[i].trim().substring(0, 100)}`);
                            fileResultCount++;
                        }
                    }
                } catch {
                    // Skip binary or unreadable files
                }
            }

            if (results.length === 0) {
                return { success: true, output: `No matches found for "${query}"` };
            }

            return {
                success: true,
                output: `Found ${results.length} matches:\n${results.join('\n')}`
            };
        } catch (error) {
            return {
                success: false,
                output: '',
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    private async executeGetSymbols(filePath: string, workspaceFolder: string): Promise<ToolResult> {
        try {
            const fullPath = path.join(workspaceFolder, filePath);
            const uri = vscode.Uri.file(fullPath);

            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                uri
            );

            if (!symbols || symbols.length === 0) {
                return { success: true, output: 'No symbols found in this file.' };
            }

            const formatSymbols = (syms: vscode.DocumentSymbol[], indent: string = ''): string => {
                return syms.map(s => {
                    const kind = vscode.SymbolKind[s.kind];
                    let result = `${indent}${kind}: ${s.name} (line ${s.range.start.line + 1})`;
                    if (s.children && s.children.length > 0) {
                        result += '\n' + formatSymbols(s.children, indent + '  ');
                    }
                    return result;
                }).join('\n');
            };

            return { success: true, output: `Symbols in ${filePath}:\n${formatSymbols(symbols)}` };
        } catch (error) {
            return {
                success: false,
                output: '',
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    private async executeFindReferences(
        filePath: string,
        symbolName: string,
        line: number,
        workspaceFolder: string
    ): Promise<ToolResult> {
        try {
            const fullPath = path.join(workspaceFolder, filePath);
            const uri = vscode.Uri.file(fullPath);
            const doc = await vscode.workspace.openTextDocument(uri);
            const lineText = doc.lineAt(line - 1).text;
            const column = lineText.indexOf(symbolName);

            if (column === -1) {
                return { success: false, output: '', error: `Symbol "${symbolName}" not found on line ${line}` };
            }

            const position = new vscode.Position(line - 1, column);
            const locations = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeReferenceProvider',
                uri,
                position
            );

            if (!locations || locations.length === 0) {
                return { success: true, output: `No references found for "${symbolName}"` };
            }

            const refs = locations.map(loc => {
                const relPath = path.relative(workspaceFolder, loc.uri.fsPath);
                return `${relPath}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
            });

            return { success: true, output: `Found ${refs.length} references:\n${refs.join('\n')}` };
        } catch (error) {
            return {
                success: false,
                output: '',
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    private async executeCreateDirectory(dirPath: string, workspaceFolder: string): Promise<ToolResult> {
        try {
            const fullPath = path.join(workspaceFolder, dirPath);

            if (!fullPath.startsWith(workspaceFolder)) {
                return { success: false, output: '', error: 'Path is outside workspace' };
            }

            fs.mkdirSync(fullPath, { recursive: true });
            return { success: true, output: `Created directory: ${dirPath}` };
        } catch (error) {
            return {
                success: false,
                output: '',
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    private async executeDeleteFile(filePath: string, workspaceFolder: string): Promise<ToolResult> {
        try {
            const fullPath = path.join(workspaceFolder, filePath);

            if (!fullPath.startsWith(workspaceFolder)) {
                return { success: false, output: '', error: 'Path is outside workspace' };
            }

            if (!fs.existsSync(fullPath)) {
                return { success: false, output: '', error: 'File or directory does not exist' };
            }

            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                fs.rmSync(fullPath, { recursive: true });
            } else {
                fs.unlinkSync(fullPath);
            }

            return { success: true, output: `Deleted: ${filePath}` };
        } catch (error) {
            return {
                success: false,
                output: '',
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    private async executeGitStatus(workspaceFolder: string): Promise<ToolResult> {
        return new Promise((resolve) => {
            cp.exec('git status --porcelain', { cwd: workspaceFolder }, (error, stdout, stderr) => {
                if (error) {
                    resolve({ success: false, output: '', error: stderr || error.message });
                } else {
                    if (!stdout.trim()) {
                        resolve({ success: true, output: 'Working tree is clean - no changes.' });
                    } else {
                        const lines = stdout.trim().split('\n');
                        const formatted = lines.map(line => {
                            const status = line.substring(0, 2);
                            const file = line.substring(3);
                            let statusText = '';
                            if (status.includes('M')) { statusText = 'Modified'; }
                            else if (status.includes('A')) { statusText = 'Added'; }
                            else if (status.includes('D')) { statusText = 'Deleted'; }
                            else if (status.includes('?')) { statusText = 'Untracked'; }
                            else if (status.includes('R')) { statusText = 'Renamed'; }
                            else { statusText = status.trim(); }
                            return `${statusText}: ${file}`;
                        });
                        resolve({ success: true, output: `Git Status:\n${formatted.join('\n')}` });
                    }
                }
            });
        });
    }

    private async executeGitDiff(filePath: string | undefined, workspaceFolder: string): Promise<ToolResult> {
        return new Promise((resolve) => {
            const command = filePath ? `git diff -- "${filePath}"` : 'git diff';
            cp.exec(command, { cwd: workspaceFolder, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
                if (error) {
                    resolve({ success: false, output: '', error: stderr || error.message });
                } else {
                    if (!stdout.trim()) {
                        resolve({ success: true, output: 'No differences found.' });
                    } else {
                        // Limit diff output
                        const lines = stdout.split('\n');
                        const limited = lines.slice(0, 100).join('\n');
                        const output = lines.length > 100 
                            ? limited + `\n\n... (${lines.length - 100} more lines truncated)`
                            : limited;
                        resolve({ success: true, output });
                    }
                }
            });
        });
    }
}

// Singleton instance
let agentInstance: AgentProvider | null = null;

export function getAgentProvider(): AgentProvider {
    if (!agentInstance) {
        agentInstance = new AgentProvider();
    }
    return agentInstance;
}
