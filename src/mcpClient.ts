import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';

// MCP Protocol Types
export interface MCPTool {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties?: Record<string, { type: string; description?: string }>;
        required?: string[];
    };
}

export interface MCPResource {
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
}

export interface MCPServerConfig {
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    enabled?: boolean;
}

interface JsonRpcRequest {
    jsonrpc: '2.0';
    id: number;
    method: string;
    params?: unknown;
}

interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: number;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

export class MCPServer {
    private process: cp.ChildProcess | null = null;
    private requestId = 0;
    private pendingRequests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    private buffer = '';
    private _tools: MCPTool[] = [];
    private _resources: MCPResource[] = [];
    private _connected = false;

    constructor(
        public readonly config: MCPServerConfig,
        private outputChannel: vscode.OutputChannel
    ) {}

    get name(): string {
        return this.config.name;
    }

    get tools(): MCPTool[] {
        return this._tools;
    }

    get resources(): MCPResource[] {
        return this._resources;
    }

    get connected(): boolean {
        return this._connected;
    }

    isConnected(): boolean {
        return this._connected;
    }

    getTools(): MCPTool[] {
        return this._tools;
    }

    async connect(): Promise<void> {
        if (this._connected) return;

        this.outputChannel.appendLine(`[MCP] Starting server: ${this.config.name}`);
        this.outputChannel.appendLine(`[MCP] Command: ${this.config.command} ${(this.config.args || []).join(' ')}`);

        try {
            this.process = cp.spawn(this.config.command, this.config.args || [], {
                env: { ...process.env, ...this.config.env },
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: true,
            });

            this.process.stdout?.on('data', (data: Buffer) => {
                this.handleData(data.toString());
            });

            this.process.stderr?.on('data', (data: Buffer) => {
                this.outputChannel.appendLine(`[MCP ${this.config.name}] stderr: ${data.toString()}`);
            });

            this.process.on('error', (err) => {
                this.outputChannel.appendLine(`[MCP ${this.config.name}] Process error: ${err.message}`);
                this._connected = false;
            });

            this.process.on('exit', (code) => {
                this.outputChannel.appendLine(`[MCP ${this.config.name}] Process exited with code ${code}`);
                this._connected = false;
            });

            // Initialize the connection
            await this.initialize();
            this._connected = true;

            // Get available tools and resources
            await this.refreshCapabilities();

            this.outputChannel.appendLine(`[MCP ${this.config.name}] Connected! Tools: ${this._tools.length}, Resources: ${this._resources.length}`);
        } catch (error) {
            this.outputChannel.appendLine(`[MCP ${this.config.name}] Failed to connect: ${error}`);
            this.disconnect();
            throw error;
        }
    }

    disconnect(): void {
        if (this.process) {
            this.process.kill();
            this.process = null;
        }
        this._connected = false;
        this._tools = [];
        this._resources = [];
        this.pendingRequests.clear();
    }

    private handleData(data: string): void {
        this.buffer += data;

        // Process complete JSON-RPC messages (newline-delimited)
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';

        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const response: JsonRpcResponse = JSON.parse(line);
                const pending = this.pendingRequests.get(response.id);
                if (pending) {
                    this.pendingRequests.delete(response.id);
                    if (response.error) {
                        pending.reject(new Error(response.error.message));
                    } else {
                        pending.resolve(response.result);
                    }
                }
            } catch (e) {
                this.outputChannel.appendLine(`[MCP ${this.config.name}] Parse error: ${e}`);
            }
        }
    }

    private async sendRequest(method: string, params?: unknown): Promise<unknown> {
        if (!this.process?.stdin) {
            throw new Error('MCP server not connected');
        }

        const id = ++this.requestId;
        const request: JsonRpcRequest = {
            jsonrpc: '2.0',
            id,
            method,
            params,
        };

        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });

            const timeout = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`Request timeout: ${method}`));
            }, 30000);

            this.process!.stdin!.write(JSON.stringify(request) + '\n', (err) => {
                if (err) {
                    clearTimeout(timeout);
                    this.pendingRequests.delete(id);
                    reject(err);
                }
            });
        });
    }

    private async initialize(): Promise<void> {
        await this.sendRequest('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: {
                name: 'rubin-vscode',
                version: '0.6.0',
            },
        });

        await this.sendRequest('notifications/initialized', {});
    }

    async refreshCapabilities(): Promise<void> {
        try {
            // Get tools
            const toolsResult = await this.sendRequest('tools/list', {}) as { tools: MCPTool[] };
            this._tools = toolsResult?.tools || [];
        } catch (e) {
            this._tools = [];
        }

        try {
            // Get resources
            const resourcesResult = await this.sendRequest('resources/list', {}) as { resources: MCPResource[] };
            this._resources = resourcesResult?.resources || [];
        } catch (e) {
            this._resources = [];
        }
    }

    async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
        const result = await this.sendRequest('tools/call', {
            name,
            arguments: args,
        });
        return result;
    }

    async readResource(uri: string): Promise<string> {
        const result = await this.sendRequest('resources/read', { uri }) as { contents: Array<{ text?: string; blob?: string }> };
        if (result?.contents?.[0]?.text) {
            return result.contents[0].text;
        }
        if (result?.contents?.[0]?.blob) {
            return Buffer.from(result.contents[0].blob, 'base64').toString();
        }
        return '';
    }
}

// MCP Manager - handles multiple servers
export class MCPManager {
    private servers = new Map<string, MCPServer>();
    private outputChannel: vscode.OutputChannel;
    private _onServersChanged = new vscode.EventEmitter<void>();
    public readonly onServersChanged = this._onServersChanged.event;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Rubin MCP');
    }

    async loadServersFromConfig(): Promise<void> {
        const config = vscode.workspace.getConfiguration('rubin');
        const serverConfigs = config.get<MCPServerConfig[]>('mcpServers', []);

        // Disconnect servers that are no longer in config
        for (const [name, server] of this.servers) {
            if (!serverConfigs.find(c => c.name === name)) {
                server.disconnect();
                this.servers.delete(name);
            }
        }

        // Connect new/updated servers
        for (const serverConfig of serverConfigs) {
            if (serverConfig.enabled === false) continue;
            
            if (!this.servers.has(serverConfig.name)) {
                const server = new MCPServer(serverConfig, this.outputChannel);
                try {
                    await server.connect();
                    this.servers.set(serverConfig.name, server);
                } catch (error) {
                    this.outputChannel.appendLine(`Failed to connect to MCP server ${serverConfig.name}: ${error}`);
                }
            }
        }

        this._onServersChanged.fire();
    }

    async addServer(config: MCPServerConfig): Promise<boolean> {
        const workspaceConfig = vscode.workspace.getConfiguration('rubin');
        const servers = workspaceConfig.get<MCPServerConfig[]>('mcpServers', []);
        
        // Check if server already exists
        if (servers.find(s => s.name === config.name)) {
            vscode.window.showWarningMessage(`MCP server "${config.name}" already exists`);
            return false;
        }

        servers.push(config);
        await workspaceConfig.update('mcpServers', servers, vscode.ConfigurationTarget.Global);
        await this.loadServersFromConfig();
        return true;
    }

    async removeServer(name: string): Promise<void> {
        const server = this.servers.get(name);
        if (server) {
            server.disconnect();
            this.servers.delete(name);
        }

        const workspaceConfig = vscode.workspace.getConfiguration('rubin');
        const servers = workspaceConfig.get<MCPServerConfig[]>('mcpServers', []);
        const filtered = servers.filter(s => s.name !== name);
        await workspaceConfig.update('mcpServers', filtered, vscode.ConfigurationTarget.Global);
        this._onServersChanged.fire();
    }

    getServers(): MCPServer[] {
        return Array.from(this.servers.values());
    }

    getConnectedServers(): MCPServer[] {
        return Array.from(this.servers.values()).filter(s => s.connected);
    }

    getAllTools(): Array<{ server: string; tool: MCPTool }> {
        const tools: Array<{ server: string; tool: MCPTool }> = [];
        for (const server of this.servers.values()) {
            if (server.connected) {
                for (const tool of server.tools) {
                    tools.push({ server: server.name, tool });
                }
            }
        }
        return tools;
    }

    async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
        const server = this.servers.get(serverName);
        if (!server?.connected) {
            throw new Error(`MCP server "${serverName}" is not connected`);
        }
        return server.callTool(toolName, args);
    }

    showOutput(): void {
        this.outputChannel.show();
    }

    dispose(): void {
        for (const server of this.servers.values()) {
            server.disconnect();
        }
        this.servers.clear();
        this.outputChannel.dispose();
    }
}

// Singleton instance
let mcpManager: MCPManager | null = null;

export function getMCPManager(): MCPManager {
    if (!mcpManager) {
        mcpManager = new MCPManager();
    }
    return mcpManager;
}

export function disposeMCPManager(): void {
    if (mcpManager) {
        mcpManager.dispose();
        mcpManager = null;
    }
}
