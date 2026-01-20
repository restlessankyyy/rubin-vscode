import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { getConfig } from './config';
import { getOllamaClient } from './ollamaClient';
import { getMCPManager, MCPTool } from './mcpClient';

// Terminal history for context
interface TerminalCommand {
    command: string;
    output: string;
    success: boolean;
    timestamp: Date;
}

// Keep track of recent terminal commands
const terminalHistory: TerminalCommand[] = [];
const MAX_TERMINAL_HISTORY = 10;

// Tool definitions that the AI can call
export interface AgentTool {
    name: string;
    description: string;
    parameters: Record<string, { type: string; description: string; required?: boolean }>;
    mcpServer?: string; // If this tool comes from an MCP server
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
    {
        name: 'getTerminalHistory',
        description: 'Get recent terminal command history with their outputs. Useful to see what commands were run and their results.',
        parameters: {},
    },
];

export class AgentProvider {
    private isRunning: boolean = false;
    private abortController: AbortController | null = null;
    private conversationHistory: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];
    private eventCallback: AgentEventCallback | null = null;
    private lastFailedToolCall: string | null = null;
    private consecutiveFailures: number = 0;

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

    private async getGitContext(workspaceFolder: string): Promise<string> {
        // Check if this is a git repository
        const gitDir = path.join(workspaceFolder, '.git');
        const isGitRepo = fs.existsSync(gitDir);
        
        if (!isGitRepo) {
            return `⚠️ GIT CONTEXT: This is NOT a git repository. You need to run "git init" first before any git operations.`;
        }

        // Get git status, branch, and remote info
        try {
            const status = await new Promise<string>((resolve) => {
                cp.exec('git status --short', { cwd: workspaceFolder }, (error, stdout) => {
                    if (error) {
                        resolve('Unable to get git status');
                    } else {
                        resolve(stdout.trim() || 'Working tree clean');
                    }
                });
            });

            const branch = await new Promise<string>((resolve) => {
                cp.exec('git branch --show-current', { cwd: workspaceFolder }, (error, stdout) => {
                    resolve(error ? 'unknown' : stdout.trim() || 'HEAD detached');
                });
            });

            const remotes = await new Promise<string>((resolve) => {
                cp.exec('git remote -v', { cwd: workspaceFolder }, (error, stdout) => {
                    if (error || !stdout.trim()) {
                        resolve('NO REMOTES CONFIGURED');
                    } else {
                        // Extract unique remote names and URLs
                        const lines = stdout.trim().split('\n');
                        const remoteInfo = lines
                            .filter(l => l.includes('(push)'))
                            .map(l => l.replace('(push)', '').trim())
                            .join(', ');
                        resolve(remoteInfo || 'NO REMOTES CONFIGURED');
                    }
                });
            });

            let context = `GIT CONTEXT:\n- Repository: initialized ✓\n- Branch: ${branch}\n- Status: ${status}\n- Remotes: ${remotes}`;
            
            if (remotes === 'NO REMOTES CONFIGURED') {
                context += `\n\n⚠️ WARNING: No remote is configured. To push, you need to add a remote first:\n  git remote add origin <repository-url>\n\nAsk the user for the repository URL if they want to push.`;
            }

            return context;
        } catch {
            return 'GIT CONTEXT: Repository initialized but unable to get status.';
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
        this.lastFailedToolCall = null;
        this.consecutiveFailures = 0;

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceFolder) {
            this.isRunning = false;
            throw new Error('No workspace folder open');
        }

        try {
            // Build the system prompt with tool definitions
            const systemPrompt = this.buildSystemPrompt();

            // Pre-gather context for git-related tasks
            let taskWithContext = task;
            if (/git|commit|push|branch|merge/i.test(task)) {
                const gitContext = await this.getGitContext(workspaceFolder);
                taskWithContext = `${gitContext}\n\nTask: ${task}`;
            }

            // Add user task to history
            this.conversationHistory.push({ role: 'user', content: taskWithContext });

            let finalResponse = '';
            let iterations = 0;
            let nudgeCount = 0;
            const maxIterations = 15; // Safety limit
            const maxNudges = 2; // Limit how many times we nudge the model

            while (iterations < maxIterations && this.isRunning) {
                iterations++;

                this.emitStep({
                    type: 'thinking',
                    content: `Step ${iterations}...`,
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
                    // Check for repeated failed tool calls (prevents infinite loops)
                    const toolCallKey = `${toolCall.name}:${JSON.stringify(toolCall.parameters)}`;
                    if (toolCallKey === this.lastFailedToolCall) {
                        this.consecutiveFailures++;
                        if (this.consecutiveFailures >= 2) {
                            this.emitStep({
                                type: 'response',
                                content: `⚠️ Stopping: The same action failed ${this.consecutiveFailures} times. Please try a different approach or check if the command is valid.`,
                                timestamp: new Date(),
                            });
                            this.lastFailedToolCall = null;
                            this.consecutiveFailures = 0;
                            break;
                        }
                    }

                    this.emitStep({
                        type: 'tool_call',
                        content: `Calling tool: ${toolCall.name}`,
                        toolName: toolCall.name,
                        toolParams: toolCall.parameters,
                        timestamp: new Date(),
                    });

                    // Execute the tool
                    const result = await this.executeTool(toolCall, workspaceFolder);

                    // Track failures to prevent loops
                    if (!result.success) {
                        this.lastFailedToolCall = toolCallKey;
                        this.consecutiveFailures++;
                    } else {
                        this.lastFailedToolCall = null;
                        this.consecutiveFailures = 0;
                    }

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
                    
                    // Give clearer feedback on errors
                    let resultMessage: string;
                    if (result.success) {
                        resultMessage = result.output || 'Command completed successfully.';
                    } else {
                        resultMessage = `❌ FAILED: ${result.error}\n\nYou need to fix this issue before continuing. Think about what prerequisite might be missing.`;
                    }
                    
                    this.conversationHistory.push({
                        role: 'system',
                        content: `[TOOL_RESULT]\n${resultMessage}`
                    });
                } else {
                    // No tool call found in response
                    // Check if this looks like an incomplete response (planning text)
                    const looksIncomplete = this.looksLikeIncompleteResponse(response);
                    
                    if (looksIncomplete && nudgeCount < maxNudges) {
                        // Model is outputting planning text instead of using tools
                        // Nudge it to use a tool (but only a few times)
                        nudgeCount++;
                        this.conversationHistory.push({
                            role: 'assistant',
                            content: response
                        });
                        this.conversationHistory.push({
                            role: 'system',
                            content: 'You must use a tool now. Output ONLY a tool call in this exact format:\n```tool\n{"name": "toolName", "parameters": {...}}\n```\nIf the task is complete, just say "Done" with a brief summary.'
                        });
                        continue; // Try again
                    }
                    
                    // This is the final response
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
                finalResponse = `Stopped after ${iterations} steps. The task may need to be broken down into smaller parts, or the model may need clearer instructions.`;
            }

            return finalResponse;
        } finally {
            this.isRunning = false;
            this.abortController = null;
        }
    }

    private getAllTools(): AgentTool[] {
        // Start with built-in tools
        const tools: AgentTool[] = [...AGENT_TOOLS];

        // Add MCP tools
        const mcpManager = getMCPManager();
        const mcpTools = mcpManager.getAllTools();
        
        for (const { server, tool } of mcpTools) {
            const params: Record<string, { type: string; description: string; required?: boolean }> = {};
            
            if (tool.inputSchema?.properties) {
                for (const [name, schema] of Object.entries(tool.inputSchema.properties)) {
                    params[name] = {
                        type: (schema as { type?: string }).type || 'string',
                        description: (schema as { description?: string }).description || '',
                        required: tool.inputSchema.required?.includes(name),
                    };
                }
            }

            tools.push({
                name: `mcp_${server}_${tool.name}`,
                description: `[MCP: ${server}] ${tool.description}`,
                parameters: params,
                mcpServer: server,
            });
        }

        return tools;
    }

    private buildSystemPrompt(): string {
        const allTools = this.getAllTools();
        const toolDescriptions = allTools.map(tool => {
            const params = Object.entries(tool.parameters)
                .map(([name, info]) => `  - ${name}: ${info.description}`)
                .join('\n');
            return `- ${tool.name}: ${tool.description}${params ? '\n' + params : ''}`;
        }).join('\n\n');

        // Get MCP servers info
        const mcpManager = getMCPManager();
        const mcpServers = mcpManager.getConnectedServers();
        const mcpInfo = mcpServers.length > 0 
            ? `\n\nCONNECTED MCP SERVERS: ${mcpServers.map(s => s.name).join(', ')}`
            : '';

        return `You are Rubin, an AI coding agent. You MUST use tools to complete tasks. You cannot just talk - you must take action.

AVAILABLE TOOLS:
${toolDescriptions}${mcpInfo}

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

CRITICAL RULES:
1. ALWAYS use a tool when asked to do something. Never just describe or plan - USE THE TOOL.
2. Use ONE tool per response. Output the tool call and NOTHING ELSE.
3. After getting a tool result, immediately use the NEXT tool needed, or summarize if done.
4. Keep going until the ENTIRE task is complete. Don't stop after one step.
5. When fully done, give a SHORT summary (1-2 sentences). No headers like "##" or "Next Step".
6. READ THE CONTEXT CAREFULLY. If it says "NOT a git repository", run "git init" first!
7. If a command fails, understand WHY and fix the prerequisite first.

You are in a loop. Each response should be EITHER a tool call OR a final summary. Nothing else.

START NOW - use a tool immediately.`;
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
        let cleaned = response;

        // Remove ```tool blocks
        cleaned = cleaned.replace(/```tool[\s\S]*?```/g, '');
        
        // Remove any other code blocks that look like tool calls
        cleaned = cleaned.replace(/```json[\s\S]*?```/g, '');

        // Remove **TOOL_CALL** / **TOOL_RESULT** blocks
        cleaned = cleaned.replace(/\*\*TOOL_CALL:?\s*\w*\*\*[\s\S]*?(?=\n\n|\*\*|$)/gi, '');
        cleaned = cleaned.replace(/\*\*TOOL_RESULT\*\*[\s\S]*?(?=\n\n|\*\*|$)/gi, '');

        // Remove [TOOL_CALL] / [TOOL_RESULT] markers
        cleaned = cleaned.replace(/\[TOOL_CALL:?\s*\w*\][\s\S]*?(?=\n\n|\[|$)/gi, '');
        cleaned = cleaned.replace(/\[TOOL_RESULT\][\s\S]*?(?=\n\n|\[|$)/gi, '');

        // Remove model artifacts
        cleaned = cleaned.replace(/<\/?\w+_of_\w+>/g, '');
        cleaned = cleaned.replace(/<\|.*?\|>/g, '');

        // Remove role prefixes and conversation markers
        cleaned = cleaned.replace(/^(System|User|Assistant|Human|AI):\s*/gim, '');
        
        // Remove markdown headers that are just formatting noise
        cleaned = cleaned.replace(/^#{1,3}\s*$/gm, '');
        
        // Remove "Next step:" type phrases
        cleaned = cleaned.replace(/^(Next step|Step \d+|Action|Plan|Thinking|Reasoning):.*$/gim, '');
        
        // Remove lines that are just metadata
        cleaned = cleaned.replace(/^(Untracked files|nothing added to commit|use "git|Changes not staged).*$/gim, '');

        // Clean up extra whitespace
        cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

        // If everything was stripped or response is too short/meaningless, provide a default
        if (!cleaned || cleaned.length < 10 || /^[\s\n#*\-_]+$/.test(cleaned)) {
            cleaned = '✅ Task completed!';
        }

        return cleaned;
    }

    private looksLikeIncompleteResponse(response: string): boolean {
        // Check if response looks like planning/thinking rather than a final answer
        const incompletePatterns = [
            /^##\s*(Next|Step|Plan|Action)/im,
            /^(Next step|Step \d+|Plan|Action|I will|Let me|I'll|First,|Now I|Then I)/im,
            /^\*\*Step/im,
            /^(Here's|The next|To do this|I need to)/im,
            /:\s*$/m, // Ends with a colon (incomplete thought)
        ];
        
        // Check if any incomplete pattern matches
        for (const pattern of incompletePatterns) {
            if (pattern.test(response)) {
                return true;
            }
        }
        
        // If response is very short and doesn't look like a completion message
        if (response.length < 50 && !/done|complete|success|finish|✅/i.test(response)) {
            return true;
        }
        
        return false;
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
            case 'getTerminalHistory':
                return this.executeGetTerminalHistory();
            default:
                // Check if it's an MCP tool (format: mcp_serverName_toolName)
                if (toolCall.name.startsWith('mcp_')) {
                    return this.executeMCPTool(toolCall);
                }
                return { success: false, output: '', error: `Unknown tool: ${toolCall.name}` };
        }
    }

    private async executeMCPTool(toolCall: ToolCall): Promise<ToolResult> {
        try {
            // Parse the tool name: mcp_serverName_toolName
            const parts = toolCall.name.split('_');
            if (parts.length < 3) {
                return { success: false, output: '', error: 'Invalid MCP tool name format' };
            }
            
            const serverName = parts[1];
            const toolName = parts.slice(2).join('_'); // Handle tool names with underscores
            
            const mcpManager = getMCPManager();
            const result = await mcpManager.callTool(serverName, toolName, toolCall.parameters);
            
            // Format the result
            let output = '';
            if (typeof result === 'string') {
                output = result;
            } else if (result && typeof result === 'object') {
                // MCP tools often return { content: [...] }
                const resultObj = result as { content?: Array<{ text?: string; type?: string }> };
                if (resultObj.content && Array.isArray(resultObj.content)) {
                    output = resultObj.content
                        .map((c: { text?: string }) => c.text || '')
                        .filter(Boolean)
                        .join('\n');
                } else {
                    output = JSON.stringify(result, null, 2);
                }
            }
            
            return { success: true, output };
        } catch (error) {
            return {
                success: false,
                output: '',
                error: error instanceof Error ? error.message : 'MCP tool execution failed',
            };
        }
    }

    private async executeRunCommand(command: string, cwd: string): Promise<ToolResult> {
        return new Promise((resolve) => {
            // Create or reuse a visible terminal for agent commands
            let terminal = vscode.window.terminals.find(t => t.name === 'Rubin Agent');
            if (!terminal) {
                terminal = vscode.window.createTerminal({
                    name: 'Rubin Agent',
                    cwd: cwd
                });
            }
            
            // Show the terminal so user can see what's happening
            terminal.show(true);
            
            // Add a visual marker in terminal
            terminal.sendText(`echo "🤖 Rubin executing: ${command.replace(/"/g, '\\"')}"`);
            terminal.sendText(command);
            
            // Run the command in the background to capture output
            const timeout = 30000; // 30 second timeout

            cp.exec(command, { cwd, timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
                const result: ToolResult = error ? {
                    success: false,
                    output: stdout || '',
                    error: stderr || error.message,
                } : {
                    success: true,
                    output: stdout + (stderr ? `\nStderr: ${stderr}` : ''),
                };
                
                // Store in terminal history
                terminalHistory.push({
                    command,
                    output: result.output || result.error || '',
                    success: result.success,
                    timestamp: new Date(),
                });
                
                // Keep history limited
                while (terminalHistory.length > MAX_TERMINAL_HISTORY) {
                    terminalHistory.shift();
                }
                
                resolve(result);
            });
        });
    }

    private executeGetTerminalHistory(): ToolResult {
        if (terminalHistory.length === 0) {
            return { success: true, output: 'No terminal commands have been run yet in this session.' };
        }
        
        let output = 'Recent terminal commands:\n\n';
        for (const cmd of terminalHistory) {
            const status = cmd.success ? '✓' : '✗';
            const time = cmd.timestamp.toLocaleTimeString();
            output += `[${time}] ${status} $ ${cmd.command}\n`;
            if (cmd.output) {
                const lines = cmd.output.split('\n').slice(0, 10);
                output += lines.map(l => `  ${l}`).join('\n');
                if (cmd.output.split('\n').length > 10) {
                    output += '\n  ... (output truncated)';
                }
                output += '\n';
            }
            output += '\n';
        }
        
        return { success: true, output };
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
