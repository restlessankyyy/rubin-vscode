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
    type: 'thinking' | 'tool_call' | 'tool_result' | 'response';
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
        name: 'searchFiles',
        description: 'Search for files in the workspace by name pattern.',
        parameters: {
            pattern: { type: 'string', description: 'Glob pattern to search (e.g., "**/*.ts" for all TypeScript files)', required: true },
        },
    },
    {
        name: 'listDirectory',
        description: 'List files and folders in a directory.',
        parameters: {
            dirPath: { type: 'string', description: 'Relative path to the directory from workspace root (use "." for root)', required: true },
        },
    },
];

export class AgentProvider {
    private isRunning: boolean = false;
    private abortController: AbortController | null = null;
    private conversationHistory: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];
    private eventCallback: AgentEventCallback | null = null;

    constructor() { }

    setEventCallback(callback: AgentEventCallback): void {
        this.eventCallback = callback;
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

                if (!this.isRunning) break; // Check if stopped

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
                    finalResponse = response;
                    this.conversationHistory.push({ role: 'assistant', content: response });

                    this.emitStep({
                        type: 'response',
                        content: response,
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

To run a command:
\`\`\`tool
{"name": "runCommand", "parameters": {"command": "ls -la"}}
\`\`\`

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

    private parseToolCall(response: string): ToolCall | null {
        // Look for tool call JSON block
        const toolMatch = response.match(/```tool\s*\n?([\s\S]*?)\n?```/);

        if (!toolMatch) {
            return null;
        }

        try {
            const toolJson = JSON.parse(toolMatch[1].trim());
            if (toolJson.name && typeof toolJson.name === 'string') {
                return {
                    name: toolJson.name,
                    parameters: toolJson.parameters || {},
                };
            }
        } catch (e) {
            console.error('Failed to parse tool call:', e);
        }

        return null;
    }

    private async executeTool(toolCall: ToolCall, workspaceFolder: string): Promise<ToolResult> {
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
            case 'searchFiles':
                return this.executeSearchFiles(toolCall.parameters.pattern, workspaceFolder);
            case 'listDirectory':
                return this.executeListDirectory(toolCall.parameters.dirPath, workspaceFolder);
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
}

// Singleton instance
let agentInstance: AgentProvider | null = null;

export function getAgentProvider(): AgentProvider {
    if (!agentInstance) {
        agentInstance = new AgentProvider();
    }
    return agentInstance;
}
