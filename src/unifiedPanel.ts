import * as vscode from 'vscode';
import * as path from 'path';
import { getConfig, setModel } from './config';
import { getOllamaClient } from './ollamaClient';
import { getAgentProvider, AgentStep } from './agentProvider';
import { ContextManager } from './contextManager';
import { parseSlashCommand, buildCommandContext } from './slashCommands';
import { processMessage } from './participants';
import { CHAT_SYSTEM_PROMPT, generateFollowUpSuggestions } from './prompts';

export class UnifiedPanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'rubin.unifiedView';
    private _view?: vscode.WebviewView;
    private _conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    private _attachedFiles: Array<{ name: string; content: string; language: string }> = [];
    private _currentMode: 'chat' | 'agent' = 'chat';
    private _contextManager: ContextManager;

    constructor(private readonly _extensionUri: vscode.Uri) {
        this._contextManager = new ContextManager();
    }

    // ... resolveWebviewView ...
    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview();

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                // ... cases ...
                case 'sendMessage':
                    if (this._currentMode === 'agent') {
                        await this._handleAgentMessage(data.message);
                    } else {
                        await this._handleChatMessage(data.message);
                    }
                    break;
                case 'changeMode':
                    this._currentMode = data.mode;
                    break;
                case 'changeModel':
                    await setModel(data.model);
                    vscode.window.showInformationMessage(`Model changed to ${data.model}`);
                    break;
                case 'getModels':
                    await this._loadModels();
                    break;
                case 'attachFile':
                    await this._attachCurrentFile();
                    break;
                case 'removeFile':
                    this._attachedFiles = this._attachedFiles.filter(f => f.name !== data.fileName);
                    this._postMessage({ type: 'filesUpdated', files: this._attachedFiles.map(f => f.name) });
                    break;
                case 'clearChat':
                    this._conversationHistory = [];
                    this._attachedFiles = [];
                    getAgentProvider().clearHistory();
                    this._postMessage({ type: 'cleared' });
                    break;
                case 'stopAgent':
                    getAgentProvider().stop();
                    this._postMessage({ type: 'agentStopped' });
                    break;
                case 'approveAction':
                    getAgentProvider().approveRequest();
                    break;
                case 'denyAction':
                    getAgentProvider().rejectRequest();
                    break;
            }
        });

        // Set up agent event callback
        getAgentProvider().setEventCallback((step: AgentStep) => {
            this._postMessage({
                type: 'agentStep',
                step: {
                    ...step,
                    timestamp: step.timestamp.toISOString(),
                },
            });
        });

        // Load models when view opens
        this._loadModels();
    }

    private async _loadModels() {
        const config = getConfig();
        const client = getOllamaClient(config.serverUrl);
        const models = await client.getAvailableModels();
        this._postMessage({
            type: 'modelsLoaded',
            models: models,
            currentModel: config.model
        });
    }

    private async _attachCurrentFile() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('No file open to attach');
            return;
        }

        const fileName = path.basename(editor.document.fileName);
        const content = editor.document.getText();
        const language = editor.document.languageId;

        // Check if already attached
        if (this._attachedFiles.some(f => f.name === fileName)) {
            vscode.window.showInformationMessage(`${fileName} is already attached`);
            return;
        }

        this._attachedFiles.push({ name: fileName, content, language });
        this._postMessage({
            type: 'filesUpdated',
            files: this._attachedFiles.map(f => f.name)
        });
    }

    private async _handleChatMessage(message: string) {
        // Check for slash commands
        const { command, args } = parseSlashCommand(message);
        
        let processedMessage = message;
        let slashCommandContext = '';
        
        if (command) {
            // Handle /help specially - just return the help text
            if (command.name === 'help') {
                const helpText = await command.handler(args, await buildCommandContext());
                this._postMessage({ type: 'userMessage', content: message });
                this._postMessage({ type: 'assistantMessage', content: helpText });
                return;
            }
            
            // Build context and execute the slash command to get the prompt
            const context = await buildCommandContext();
            slashCommandContext = await command.handler(args, context);
        }

        // Process @mentions to gather additional context
        const mentionResult = await processMessage(message);
        const mentionContext = mentionResult.contextBlocks.join('\n\n');
        processedMessage = slashCommandContext || mentionResult.cleanMessage;

        // Add user message to history
        this._conversationHistory.push({ role: 'user', content: message });
        this._postMessage({ type: 'userMessage', content: message });
        this._postMessage({ type: 'typing', isTyping: true });

        try {
            const config = getConfig();
            const client = getOllamaClient(config.serverUrl);

            // 1. Gather comprehensive context
            const contextItems = await this._contextManager.getContext();
            let context = this._contextManager.formatContextForPrompt(contextItems);

            // 2. Add @mention context
            if (mentionContext) {
                context = mentionContext + '\n\n' + context;
            }

            // 3. Add manually attached files (if they aren't already covered)
            for (const file of this._attachedFiles) {
                if (!context.includes(`Filename: ${file.name}`)) {
                    context += `\n\n### Attached File: ${file.name}\n\`\`\`${file.language}\n${file.content}\n\`\`\``;
                }
            }

            // Use streaming for real-time response
            const prompt = this._buildChatPrompt(processedMessage, context);
            const hasCodeContext = context.includes('```') || message.includes('code');
            
            // Create a message placeholder for streaming
            this._postMessage({ type: 'streamStart' });

            await client.generateChatStream(
                prompt,
                config,
                {
                    onToken: (token) => {
                        this._postMessage({ type: 'streamToken', token });
                    },
                    onComplete: (response) => {
                        this._conversationHistory.push({ role: 'assistant', content: response });
                        this._postMessage({ type: 'streamEnd' });
                        
                        // Generate follow-up suggestions
                        const followUps = generateFollowUpSuggestions(message, response, hasCodeContext);
                        if (followUps.length > 0) {
                            this._postMessage({ type: 'followUpSuggestions', suggestions: followUps });
                        }
                    },
                    onError: (error) => {
                        this._postMessage({
                            type: 'error',
                            content: `Streaming error: ${error.message}`
                        });
                    }
                }
            );

        } catch (error) {
            // Fall back to non-streaming if streaming fails
            try {
                const config = getConfig();
                const client = getOllamaClient(config.serverUrl);
                const contextItems = await this._contextManager.getContext();
                const context = this._contextManager.formatContextForPrompt(contextItems);
                const prompt = this._buildChatPrompt(processedMessage, context);
                
                const response = await client.generateChat(prompt, config);
                if (response) {
                    this._conversationHistory.push({ role: 'assistant', content: response });
                    this._postMessage({ type: 'assistantMessage', content: response });
                } else {
                    this._postMessage({
                        type: 'error',
                        content: 'Failed to get response. Check if Ollama is running.'
                    });
                }
            } catch (fallbackError) {
                this._postMessage({
                    type: 'error',
                    content: `Error: ${fallbackError instanceof Error ? fallbackError.message : 'Unknown error'}`
                });
            }
        } finally {
            this._postMessage({ type: 'typing', isTyping: false });
        }
    }


    private async _handleAgentMessage(message: string) {
        this._postMessage({ type: 'userMessage', content: message });
        this._postMessage({ type: 'agentStarted' });

        try {
            const agent = getAgentProvider();

            // 1. Gather comprehensive context
            const contextItems = await this._contextManager.getContext();
            let fullMessage = this._contextManager.formatContextForPrompt(contextItems) + `\n\nTask: ${message}`;

            // 2. Add manually attached files if not already covered
            // (Similar logic to chat, ensure no duplicates for files already in context)
            if (this._attachedFiles.length > 0) {
                let extraContext = '';
                for (const file of this._attachedFiles) {
                    if (!fullMessage.includes(`Active File: ${file.name}`) && !fullMessage.includes(`Open File: ${file.name}`)) {
                        extraContext += `\n\nFile: ${file.name}\n\`\`\`${file.language}\n${file.content}\n\`\`\``;
                    }
                }
                if (extraContext) {
                    fullMessage = `Context files:${extraContext}\n\n${fullMessage}`;
                }
            }

            const result = await agent.runTask(fullMessage);
            this._postMessage({ type: 'assistantMessage', content: result });
        } catch (error) {
            this._postMessage({
                type: 'error',
                content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
            });
        } finally {
            this._postMessage({ type: 'agentStopped' });
        }
    }

    private _buildChatPrompt(message: string, context: string): string {
        let prompt = CHAT_SYSTEM_PROMPT + '\n\n';

        if (context) {
            prompt += '## Current Context\n\n' + context + '\n\n';
        }

        // Add conversation history for continuity
        prompt += '## Conversation\n\n';

        for (const msg of this._conversationHistory.slice(-6)) {
            if (msg.role === 'user') {
                prompt += `User: ${msg.content}\n\n`;
            } else {
                prompt += `Assistant: ${msg.content}\n\n`;
            }
        }

        prompt += `User: ${message}\n\nAssistant:`;
        return prompt;
    }

    private _postMessage(message: unknown) {
        if (this._view) {
            this._view.webview.postMessage(message);
        }
    }

    public addCodeToChat(code: string, languageId: string) {
        this._postMessage({
            type: 'addCode',
            code: code,
            language: languageId
        });
    }

    /**
     * Send a message to the chat programmatically (used by code actions)
     */
    public sendMessageToChat(message: string) {
        // Focus the view first
        vscode.commands.executeCommand('rubin.unifiedView.focus');
        // Then send the message
        this._postMessage({
            type: 'injectMessage',
            message: message
        });
    }
    private _getHtmlForWebview(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Rubin</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: var(--vscode-font-family);
            font-size: 13px;
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background);
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        
        /* Header */
        .header {
            padding: 10px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .header h3 {
            font-size: 13px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .header-actions {
            margin-left: auto;
            display: flex;
            gap: 6px;
        }
        .icon-btn {
            background: transparent;
            border: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            padding: 4px;
            border-radius: 4px;
            font-size: 14px;
        }
        .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
        
        /* Messages */
        .messages {
            flex: 1;
            overflow-y: auto;
            padding: 12px;
        }
        .message {
            margin-bottom: 16px;
            animation: fadeIn 0.2s ease;
        }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(5px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .message-header {
            font-size: 11px;
            font-weight: 600;
            margin-bottom: 4px;
            color: var(--vscode-descriptionForeground);
        }
        .user-message .message-header { color: var(--vscode-textLink-foreground); }
        .assistant-message .message-header { color: var(--vscode-charts-green); }
        .message-content {
            background: var(--vscode-input-background);
            padding: 10px 12px;
            border-radius: 8px;
            line-height: 1.5;
            word-wrap: break-word;
        }
        .user-message .message-content {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .message-content pre {
            background: var(--vscode-textCodeBlock-background);
            padding: 8px;
            border-radius: 4px;
            overflow-x: auto;
            margin: 8px 0;
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
        }
        .message-content code {
            background: var(--vscode-textCodeBlock-background);
            padding: 2px 4px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
        }
        .message-content pre code { background: none; padding: 0; }
        
        /* Agent Steps - Subtle inline display */
        .agent-step {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 4px 8px;
            margin: 2px 4px 2px 0;
            border-radius: 12px;
            font-size: 11px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }
        .step-thinking { opacity: 0.7; }
        .step-tool_call { background: var(--vscode-inputValidation-warningBackground); }
        .step-tool_result { background: var(--vscode-charts-green); color: white; }
        .step-tool_result.error { background: var(--vscode-errorForeground); }
        .step-header { font-size: 11px; }
        .step-content { display: none; } /* Hide verbose content by default */
        .agent-steps-container { margin-bottom: 8px; }
        
        /* Typing indicator */
        .typing {
            display: none;
            padding: 8px 12px;
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }
        .typing.visible { display: block; }
        .typing::after { content: ''; animation: dots 1.5s infinite; }
        @keyframes dots {
            0%, 20% { content: '.'; }
            40% { content: '..'; }
            60%, 100% { content: '...'; }
        }
        
        /* Input area */
        .input-area {
            padding: 12px;
            border-top: 1px solid var(--vscode-panel-border);
        }
        
        /* Attached files */
        .attached-files {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-bottom: 8px;
        }
        .attached-files:empty { display: none; }
        .file-chip {
            display: flex;
            align-items: center;
            gap: 4px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 3px 8px;
            border-radius: 12px;
            font-size: 11px;
        }
        .file-chip button {
            background: none;
            border: none;
            color: inherit;
            cursor: pointer;
            padding: 0;
            font-size: 12px;
            opacity: 0.7;
        }
        .file-chip button:hover { opacity: 1; }
        
        /* Toolbar */
        .toolbar {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 8px;
        }
        .mode-select, .model-select {
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 4px;
            padding: 4px 8px;
            font-size: 11px;
            cursor: pointer;
        }
        .mode-select { font-weight: 600; }
        .toolbar-spacer { flex: 1; }
        
        /* Input wrapper */
        .input-wrapper {
            display: flex;
            align-items: flex-end;
            gap: 8px;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 8px;
            padding: 8px;
        }
        .input-wrapper:focus-within {
            border-color: var(--vscode-focusBorder);
        }
        textarea {
            flex: 1;
            background: transparent;
            color: var(--vscode-input-foreground);
            border: none;
            font-family: var(--vscode-font-family);
            font-size: 13px;
            resize: none;
            min-height: 24px;
            max-height: 150px;
            outline: none;
        }
        textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
        .input-actions {
            display: flex;
            gap: 4px;
        }
        .send-btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            width: 28px;
            height: 28px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .send-btn:hover { background: var(--vscode-button-hoverBackground); }
        .send-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        
        /* Welcome */
        .welcome {
            text-align: center;
            padding: 30px 20px;
            color: var(--vscode-descriptionForeground);
        }
        .welcome h2 { color: var(--vscode-foreground); margin-bottom: 8px; font-size: 16px; }
        .welcome p { font-size: 12px; margin-bottom: 16px; }
        
        /* Error */
        .error-msg {
            color: var(--vscode-errorForeground);
            background: var(--vscode-inputValidation-errorBackground);
            padding: 8px 12px;
            border-radius: 4px;
            margin-bottom: 12px;
            font-size: 12px;
        }
        
        /* Streaming indicator */
        .message.streaming .message-content::after {
            content: '▊';
            animation: blink 1s infinite;
            color: var(--vscode-textLink-foreground);
        }
        @keyframes blink { 50% { opacity: 0; } }
        
        /* Follow-up suggestions */
        .follow-ups {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin: 8px 0 16px 0;
            padding-left: 12px;
        }
        .follow-up-btn {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border, transparent);
            border-radius: 14px;
            padding: 4px 12px;
            font-size: 11px;
            cursor: pointer;
            transition: all 0.15s ease;
        }
        .follow-up-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
            transform: translateY(-1px);
        }
        
        /* @mention highlighting in input */
        .mention { 
            color: var(--vscode-textLink-foreground);
            font-weight: 600;
        }
        
        /* Agent status */
        .agent-status {
            display: none;
            align-items: center;
            gap: 8px;
            padding: 6px 10px;
            background: var(--vscode-inputValidation-infoBackground);
            border-radius: 6px;
            margin-bottom: 8px;
            font-size: 11px;
        }
        .agent-status.visible { display: flex; }
        .spinner {
            width: 12px; height: 12px;
            border: 2px solid var(--vscode-foreground);
            border-top-color: transparent;
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .stop-btn {
            margin-left: auto;
            background: var(--vscode-inputValidation-errorBackground);
            color: var(--vscode-errorForeground);
            border: none;
            padding: 3px 8px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 10px;
        }
        /* Approval Dialog */
        .approval-dialog {
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 10px;
            margin: 8px 0;
            border-left: 3px solid var(--vscode-charts-yellow);
        }
        .approval-dialog h4 { margin: 0 0 8px 0; font-size: 12px; display: flex; align-items: center; gap: 6px; }
        .approval-code { 
            background: var(--vscode-textCodeBlock-background);
            padding: 8px;
            border-radius: 4px;
            font-family: var(--vscode-editor-font-family);
            font-size: 11px;
            margin-bottom: 8px;
            overflow-x: auto;
            white-space: pre-wrap;
        }
        .approval-actions { display: flex; gap: 8px; justify-content: flex-end; }
        .btn { padding: 4px 12px; border: none; border-radius: 4px; cursor: pointer; font-size: 11px; }
        .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
        .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
        .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
        .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
        .approved { border-left-color: var(--vscode-charts-green); opacity: 0.7; }
        .denied { border-left-color: var(--vscode-errorForeground); opacity: 0.7; }
    </style>
</head>
<body>
    <div class="header">
        <h3>🤖 Rubin</h3>
        <div class="header-actions">
            <button class="icon-btn" onclick="clearChat()" title="Clear chat">🗑️</button>
        </div>
    </div>
    <!-- ... rest of HTML ... -->
    <div class="messages" id="messages">
        <div class="welcome" id="welcome">
            <h2>Hey there! 👋</h2>
            <p>I'm Rubin, your AI coding assistant.<br>Ask me anything or switch to Agent mode to automate tasks.</p>
        </div>
        <div class="typing" id="typing">Rubin is thinking</div>
    </div>

    <div class="input-area">
        <div class="agent-status" id="agentStatus">
            <div class="spinner"></div>
            <span>Agent is working...</span>
            <button class="stop-btn" onclick="stopAgent()">Stop</button>
        </div>
        
        <div class="attached-files" id="attachedFiles"></div>
        
        <div class="toolbar">
            <select class="mode-select" id="modeSelect" onchange="changeMode(this.value)">
                <option value="chat">💬 Chat</option>
                <option value="agent">🤖 Agent</option>
            </select>
            <select class="model-select" id="modelSelect" onchange="changeModel(this.value)">
                <option>Loading...</option>
            </select>
            <div class="toolbar-spacer"></div>
            <button class="icon-btn" onclick="attachFile()" title="Attach current file">📎</button>
            <button class="icon-btn" onclick="refreshModels()" title="Refresh models">🔄</button>
        </div>
        
        <div class="input-wrapper">
            <textarea id="input" placeholder="Describe what to build next..." rows="1"></textarea>
            <div class="input-actions">
                <button class="send-btn" id="sendBtn" onclick="send()" title="Send">➤</button>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const messages = document.getElementById('messages');
        const input = document.getElementById('input');
        const sendBtn = document.getElementById('sendBtn');
        const typing = document.getElementById('typing');
        const welcome = document.getElementById('welcome');
        const agentStatus = document.getElementById('agentStatus');
        const attachedFiles = document.getElementById('attachedFiles');

        function approveAction(id) {
            vscode.postMessage({ type: 'approveAction' });
            markProcessed(id, true);
        }

        function denyAction(id) {
            vscode.postMessage({ type: 'denyAction' });
            markProcessed(id, false);
        }

        function markProcessed(id, approved) {
            const el = document.getElementById(id);
            if (el) {
                el.classList.add(approved ? 'approved' : 'denied');
                const actions = el.querySelector('.approval-actions');
                actions.innerHTML = approved ? '✅ Approved' : '❌ Denied';
            }
        }

        function addApprovalRequest(step) {
            welcome.style.display = 'none';
            const div = document.createElement('div');
            const id = 'approval-' + Date.now();
            div.id = id;
            div.className = 'approval-dialog message';
            
            let details = '';
            if (step.toolName === 'runCommand') {
                details = step.toolParams.command;
            } else if (step.toolName === 'writeFile') {
                details = \`File: \${step.toolParams.filePath}\\n\\n\${step.toolParams.content.substring(0, 100)}\${step.toolParams.content.length > 100 ? '...' : ''}\`;
            }

            div.innerHTML = \`
                <h4>⚠️ Approval Required: \${step.toolName}</h4>
                <div class="approval-code">\${escapeHtml(details)}</div>
                <div class="approval-actions">
                    <button class="btn btn-secondary" onclick="denyAction('\${id}')">Deny</button>
                    <button class="btn btn-primary" onclick="approveAction('\${id}')">Allow</button>
                </div>
            \`;
            
            messages.insertBefore(div, typing);
            messages.scrollTop = messages.scrollHeight;
        }
        
        let isWaiting = false;
        let currentMode = 'chat';

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
            }
        });
        
        input.addEventListener('input', () => {
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 150) + 'px';
        });

        function send() {
            const text = input.value.trim();
            if (!text || isWaiting) return;
            vscode.postMessage({ type: 'sendMessage', message: text });
            input.value = '';
            input.style.height = 'auto';
        }

        function changeMode(mode) {
            currentMode = mode;
            vscode.postMessage({ type: 'changeMode', mode });
            input.placeholder = mode === 'agent' 
                ? 'Describe what you want me to do...' 
                : 'Ask me anything...';
        }

        function changeModel(model) {
            if (model) vscode.postMessage({ type: 'changeModel', model });
        }

        function refreshModels() {
            vscode.postMessage({ type: 'getModels' });
        }

        function attachFile() {
            vscode.postMessage({ type: 'attachFile' });
        }

        function removeFile(name) {
            vscode.postMessage({ type: 'removeFile', fileName: name });
        }

        function clearChat() {
            vscode.postMessage({ type: 'clearChat' });
        }

        function stopAgent() {
            vscode.postMessage({ type: 'stopAgent' });
        }

        function addMessage(role, content) {
            welcome.style.display = 'none';
            const div = document.createElement('div');
            div.className = 'message ' + role + '-message';
            div.innerHTML = '<div class="message-header">' + (role === 'user' ? 'You' : 'Rubin') + '</div>' +
                '<div class="message-content">' + formatContent(content) + '</div>';
            messages.insertBefore(div, typing);
            messages.scrollTop = messages.scrollHeight;
            return div;
        }

        // Streaming support
        let streamingDiv = null;
        let streamingContent = '';

        function startStreaming() {
            welcome.style.display = 'none';
            streamingContent = '';
            streamingDiv = document.createElement('div');
            streamingDiv.className = 'message assistant-message streaming';
            streamingDiv.innerHTML = '<div class="message-header">Rubin</div>' +
                '<div class="message-content"></div>';
            messages.insertBefore(streamingDiv, typing);
        }

        function appendStreamToken(token) {
            if (!streamingDiv) startStreaming();
            streamingContent += token;
            const contentDiv = streamingDiv.querySelector('.message-content');
            contentDiv.innerHTML = formatContent(streamingContent);
            messages.scrollTop = messages.scrollHeight;
        }

        function endStreaming() {
            if (streamingDiv) {
                streamingDiv.classList.remove('streaming');
                const contentDiv = streamingDiv.querySelector('.message-content');
                contentDiv.innerHTML = formatContent(streamingContent);
            }
            streamingDiv = null;
            streamingContent = '';
        }

        function addFollowUpSuggestions(suggestions) {
            const container = document.createElement('div');
            container.className = 'follow-ups';
            container.innerHTML = suggestions.map(s => 
                '<button class="follow-up-btn" onclick="useFollowUp(\\x27' + escapeHtml(s).replace(/'/g, "\\\\'") + '\\x27)">' + escapeHtml(s) + '</button>'
            ).join('');
            messages.insertBefore(container, typing);
            messages.scrollTop = messages.scrollHeight;
        }

        function useFollowUp(text) {
            input.value = text;
            send();
        }

        function addAgentStep(step) {
            // Skip thinking steps for cleaner UI
            if (step.type === 'thinking') return;
            
            welcome.style.display = 'none';
            
            // Get or create steps container
            let container = messages.querySelector('.agent-steps-container:last-of-type');
            if (!container || container.nextElementSibling !== typing) {
                container = document.createElement('div');
                container.className = 'agent-steps-container';
                messages.insertBefore(container, typing);
            }
            
            const chip = document.createElement('span');
            chip.className = 'agent-step step-' + step.type;
            if (step.type === 'tool_result' && step.result && !step.result.success) {
                chip.classList.add('error');
            }
            
            const icon = step.type === 'tool_call' ? '🔧' : (step.result?.success ? '✅' : '❌');
            const label = step.toolName || 'action';
            chip.innerHTML = icon + ' ' + label;
            chip.title = step.type === 'tool_call' 
                ? JSON.stringify(step.toolParams, null, 2)
                : (step.result?.output || step.result?.error || '');
            
            container.appendChild(chip);
            messages.scrollTop = messages.scrollHeight;
        }

        function formatContent(content) {
            let f = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            f = f.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, '<pre><code>$2</code></pre>');
            f = f.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
            f = f.replace(/\\n/g, '<br>');
            return f;
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function updateFiles(files) {
            attachedFiles.innerHTML = files.map(name => 
                '<div class="file-chip">📄 ' + name + 
                '<button onclick="removeFile(\\x27' + name + '\\x27)">×</button></div>'
            ).join('');
        }

        window.addEventListener('message', (e) => {
            const data = e.data;
            switch (data.type) {
                case 'userMessage':
                    addMessage('user', data.content);
                    break;
                case 'assistantMessage':
                    addMessage('assistant', data.content);
                    break;
                case 'typing':
                    isWaiting = data.isTyping;
                    typing.classList.toggle('visible', data.isTyping);
                    sendBtn.disabled = data.isTyping;
                    break;
                case 'agentStep':
                    if (data.step.type === 'approval_requested') {
                        addApprovalRequest(data.step);
                    } else if (data.step.type !== 'response') {
                        addAgentStep(data.step);
                    }
                    break;
                case 'agentStarted':
                    isWaiting = true;
                    agentStatus.classList.add('visible');
                    sendBtn.disabled = true;
                    break;
                case 'agentStopped':
                    isWaiting = false;
                    agentStatus.classList.remove('visible');
                    sendBtn.disabled = false;
                    break;
                case 'modelsLoaded':
                    const sel = document.getElementById('modelSelect');
                    sel.innerHTML = data.models.map(m => 
                        '<option value="' + m + '"' + (m === data.currentModel ? ' selected' : '') + '>' + m + '</option>'
                    ).join('');
                    break;
                case 'filesUpdated':
                    updateFiles(data.files);
                    break;
                case 'cleared':
                    messages.querySelectorAll('.message, .agent-step, .error-msg').forEach(el => el.remove());
                    welcome.style.display = 'block';
                    attachedFiles.innerHTML = '';
                    break;
                case 'error':
                    const err = document.createElement('div');
                    err.className = 'error-msg';
                    err.textContent = data.content;
                    messages.insertBefore(err, typing);
                    break;
                case 'addCode':
                    input.value = 'Regarding this code:\\n\`\`\`' + data.language + '\\n' + data.code + '\\n\`\`\`\\n\\n';
                    input.focus();
                    break;
                case 'injectMessage':
                    input.value = data.message;
                    send();
                    break;
                case 'streamStart':
                    startStreaming();
                    break;
                case 'streamToken':
                    appendStreamToken(data.token);
                    break;
                case 'streamEnd':
                    endStreaming();
                    break;
                case 'followUpSuggestions':
                    addFollowUpSuggestions(data.suggestions);
                    break;
            }
        });
    </script>
</body>
</html>`;
    }
}
