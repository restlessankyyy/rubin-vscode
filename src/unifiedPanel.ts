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

        // Restore conversation when view becomes visible again
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this._restoreConversation();
            }
        });

        // Load models when view opens
        this._loadModels();
        
        // Restore any existing conversation
        this._restoreConversation();
    }

    private _restoreConversation() {
        // Restore previous messages to the webview
        for (const msg of this._conversationHistory) {
            this._postMessage({
                type: msg.role === 'user' ? 'userMessage' : 'assistantMessage',
                content: msg.content
            });
        }
        // Restore attached files
        if (this._attachedFiles.length > 0) {
            this._postMessage({
                type: 'filesUpdated',
                files: this._attachedFiles.map(f => f.name)
            });
        }
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
            background: var(--vscode-editor-background);
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        
        /* Messages Area */
        .messages {
            flex: 1;
            overflow-y: auto;
            padding: 16px;
        }
        
        /* Welcome - Copilot Style */
        .welcome {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            text-align: center;
            color: var(--vscode-descriptionForeground);
            padding: 40px 20px;
        }
        .welcome-icon {
            font-size: 48px;
            margin-bottom: 16px;
            opacity: 0.6;
        }
        .welcome h2 { 
            color: var(--vscode-foreground); 
            font-size: 18px;
            font-weight: 500;
            margin-bottom: 8px;
        }
        .welcome p { 
            font-size: 12px; 
            line-height: 1.5;
            max-width: 280px;
        }
        .welcome-link {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
            cursor: pointer;
        }
        .welcome-link:hover { text-decoration: underline; }
        
        /* Message Bubbles */
        .message {
            margin-bottom: 16px;
            animation: fadeIn 0.2s ease;
        }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(4px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .message-header {
            font-size: 12px;
            font-weight: 600;
            margin-bottom: 6px;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .user-message .message-header { color: var(--vscode-foreground); }
        .assistant-message .message-header { color: var(--vscode-foreground); }
        .message-content {
            padding: 0;
            line-height: 1.6;
            word-wrap: break-word;
        }
        .user-message .message-content {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            padding: 10px 14px;
            border-radius: 12px;
            display: inline-block;
            max-width: 90%;
        }
        .assistant-message .message-content {
            color: var(--vscode-foreground);
        }
        .message-content pre {
            background: var(--vscode-textCodeBlock-background);
            padding: 12px;
            border-radius: 6px;
            overflow-x: auto;
            margin: 8px 0;
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
            border: 1px solid var(--vscode-panel-border);
        }
        .message-content code {
            background: var(--vscode-textCodeBlock-background);
            padding: 2px 6px;
            border-radius: 4px;
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
        }
        .message-content pre code { background: none; padding: 0; }
        
        /* Agent Steps - Modern chips */
        .agent-steps-container { 
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin: 12px 0;
        }
        .agent-step {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 6px 12px;
            border-radius: 6px;
            font-size: 12px;
            font-weight: 500;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-panel-border);
            transition: all 0.15s ease;
        }
        .step-tool_call { 
            border-color: var(--vscode-charts-yellow);
            background: color-mix(in srgb, var(--vscode-charts-yellow) 10%, transparent);
        }
        .step-tool_result { 
            border-color: var(--vscode-charts-green);
            background: color-mix(in srgb, var(--vscode-charts-green) 10%, transparent);
        }
        .step-tool_result.error { 
            border-color: var(--vscode-errorForeground);
            background: color-mix(in srgb, var(--vscode-errorForeground) 10%, transparent);
        }
        
        /* Typing indicator */
        .typing {
            display: none;
            padding: 12px 0;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }
        .typing.visible { display: flex; align-items: center; gap: 8px; }
        .typing-dots { display: flex; gap: 3px; }
        .typing-dot {
            width: 6px; height: 6px;
            background: var(--vscode-descriptionForeground);
            border-radius: 50%;
            animation: bounce 1.4s infinite ease-in-out;
        }
        .typing-dot:nth-child(1) { animation-delay: 0s; }
        .typing-dot:nth-child(2) { animation-delay: 0.2s; }
        .typing-dot:nth-child(3) { animation-delay: 0.4s; }
        @keyframes bounce {
            0%, 80%, 100% { transform: scale(0.8); opacity: 0.5; }
            40% { transform: scale(1); opacity: 1; }
        }
        
        /* Input area - Copilot Style */
        .input-area {
            padding: 12px 16px 16px;
            background: var(--vscode-editor-background);
            border-top: 1px solid var(--vscode-panel-border);
        }
        
        /* Attached files */
        .attached-files {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-bottom: 10px;
        }
        .attached-files:empty { display: none; }
        .file-chip {
            display: flex;
            align-items: center;
            gap: 6px;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-panel-border);
            padding: 4px 10px;
            border-radius: 6px;
            font-size: 12px;
        }
        .file-chip .file-icon { opacity: 0.7; }
        .file-chip button {
            background: none;
            border: none;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            padding: 0;
            font-size: 14px;
            line-height: 1;
        }
        .file-chip button:hover { color: var(--vscode-foreground); }
        
        /* Input box */
        .input-box {
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 8px;
            overflow: hidden;
        }
        .input-box:focus-within {
            border-color: var(--vscode-focusBorder);
        }
        textarea {
            width: 100%;
            background: transparent;
            color: var(--vscode-input-foreground);
            border: none;
            font-family: var(--vscode-font-family);
            font-size: 13px;
            resize: none;
            padding: 12px;
            min-height: 44px;
            max-height: 150px;
            outline: none;
        }
        textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
        
        /* Input toolbar */
        .input-toolbar {
            display: flex;
            align-items: center;
            padding: 6px 8px;
            gap: 4px;
            border-top: 1px solid var(--vscode-panel-border);
            background: var(--vscode-input-background);
        }
        .toolbar-btn {
            background: none;
            border: none;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            padding: 4px 6px;
            border-radius: 4px;
            font-size: 14px;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .toolbar-btn:hover { 
            background: var(--vscode-toolbar-hoverBackground); 
            color: var(--vscode-foreground);
        }
        .toolbar-btn.active { color: var(--vscode-textLink-foreground); }
        .toolbar-divider {
            width: 1px;
            height: 16px;
            background: var(--vscode-panel-border);
            margin: 0 4px;
        }
        .toolbar-spacer { flex: 1; }
        
        /* Mode & Model selects */
        .mode-select, .model-select {
            background: transparent;
            color: var(--vscode-foreground);
            border: none;
            font-size: 12px;
            cursor: pointer;
            padding: 4px 6px;
            border-radius: 4px;
        }
        .mode-select:hover, .model-select:hover {
            background: var(--vscode-toolbar-hoverBackground);
        }
        .mode-select { font-weight: 600; }
        
        /* Send button */
        .send-btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 6px;
            width: 36px;
            height: 30px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 16px;
            font-weight: bold;
            transition: all 0.2s ease;
        }
        .send-btn:hover { background: var(--vscode-button-hoverBackground); transform: scale(1.05); }
        .send-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .send-btn.processing {
            background: #e74c3c;
            color: white;
            animation: processing-pulse 1s infinite;
        }
        .send-btn.processing:hover {
            background: #c0392b;
        }
        @keyframes processing-pulse {
            0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(231, 76, 60, 0.4); }
            50% { transform: scale(1.05); box-shadow: 0 0 0 6px rgba(231, 76, 60, 0); }
        }
        
        /* Agent status */
        .agent-status {
            display: none;
            align-items: center;
            gap: 8px;
            padding: 8px 12px;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            margin-bottom: 10px;
            font-size: 12px;
        }
        .agent-status.visible { 
            display: flex; 
            animation: slideIn 0.2s ease-out;
        }
        @keyframes slideIn {
            from { opacity: 0; transform: translateY(-10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .spinner {
            width: 14px; height: 14px;
            border: 2px solid var(--vscode-descriptionForeground);
            border-top-color: var(--vscode-textLink-foreground);
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .stop-btn {
            margin-left: auto;
            background: #e74c3c;
            color: white;
            border: none;
            padding: 5px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 11px;
            font-weight: 600;
        }
        .stop-btn:hover { background: #c0392b; }
        
        /* Approval Dialog */
        .approval-dialog {
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            padding: 12px;
            margin: 12px 0;
        }
        .approval-dialog h4 { 
            margin: 0 0 10px 0; 
            font-size: 12px; 
            font-weight: 600;
            display: flex; 
            align-items: center; 
            gap: 8px; 
            color: var(--vscode-charts-yellow);
        }
        .approval-code { 
            background: var(--vscode-textCodeBlock-background);
            padding: 10px 12px;
            border-radius: 6px;
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
            margin-bottom: 12px;
            overflow-x: auto;
            white-space: pre-wrap;
            border: 1px solid var(--vscode-panel-border);
        }
        .approval-actions { display: flex; gap: 8px; justify-content: flex-end; }
        .btn { 
            padding: 6px 14px; 
            border: none; 
            border-radius: 6px; 
            cursor: pointer; 
            font-size: 12px;
            font-weight: 500;
        }
        .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
        .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
        .btn-secondary { 
            background: transparent; 
            color: var(--vscode-foreground); 
            border: 1px solid var(--vscode-panel-border);
        }
        .btn-secondary:hover { background: var(--vscode-toolbar-hoverBackground); }
        .approved .approval-actions { color: var(--vscode-charts-green); }
        .denied .approval-actions { color: var(--vscode-errorForeground); }
        
        /* Follow-up suggestions */
        .follow-ups {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin: 12px 0;
        }
        .follow-up-btn {
            background: var(--vscode-input-background);
            color: var(--vscode-foreground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 6px 12px;
            font-size: 12px;
            cursor: pointer;
            transition: all 0.15s ease;
        }
        .follow-up-btn:hover {
            border-color: var(--vscode-focusBorder);
            background: var(--vscode-toolbar-hoverBackground);
        }
        
        /* Error message */
        .error-msg {
            color: var(--vscode-errorForeground);
            background: color-mix(in srgb, var(--vscode-errorForeground) 10%, transparent);
            padding: 10px 14px;
            border-radius: 8px;
            border: 1px solid var(--vscode-errorForeground);
            margin-bottom: 12px;
            font-size: 12px;
        }
        
        /* Streaming */
        .message.streaming .message-content::after {
            content: '▋';
            animation: blink 1s infinite;
            color: var(--vscode-textLink-foreground);
        }
        @keyframes blink { 50% { opacity: 0; } }
    </style>
</head>
<body>
    <div class="messages" id="messages">
        <div class="welcome" id="welcome">
            <div class="welcome-icon">💬</div>
            <h2>Build with Rubin</h2>
            <p>AI responses may be inaccurate.<br><span class="welcome-link" onclick="showTips()">Tips for better results</span></p>
        </div>
        <div class="typing" id="typing">
            <div class="typing-dots">
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
            </div>
            <span>Rubin is thinking...</span>
        </div>
    </div>

    <div class="input-area">
        <div class="agent-status" id="agentStatus">
            <div class="spinner"></div>
            <span>Agent is working...</span>
            <button class="stop-btn" onclick="stopAgent()">Stop</button>
        </div>
        
        <div class="attached-files" id="attachedFiles"></div>
        
        <div class="input-box">
            <textarea id="input" placeholder="Describe what to build next..." rows="1"></textarea>
            <div class="input-toolbar">
                <button class="toolbar-btn" onclick="attachFile()" title="Attach file">📎</button>
                <div class="toolbar-divider"></div>
                <select class="mode-select" id="modeSelect" onchange="changeMode(this.value)">
                    <option value="chat">💬 Chat</option>
                    <option value="agent">🤖 Agent</option>
                </select>
                <select class="model-select" id="modelSelect" onchange="changeModel(this.value)">
                    <option>Loading...</option>
                </select>
                <div class="toolbar-spacer"></div>
                <button class="send-btn" id="sendBtn" onclick="handleSendClick()" title="Send">▶</button>
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

        function handleSendClick() {
            if (isWaiting) {
                stopAgent();
            } else {
                send();
            }
        }

        function setProcessingState(processing) {
            isWaiting = processing;
            if (processing) {
                sendBtn.innerHTML = '■';
                sendBtn.classList.add('processing');
                sendBtn.title = 'Stop';
            } else {
                sendBtn.innerHTML = '▶';
                sendBtn.classList.remove('processing');
                sendBtn.title = 'Send';
            }
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

        function showTips() {
            welcome.style.display = 'none';
            const div = document.createElement('div');
            div.className = 'message assistant-message';
            div.innerHTML = \`
                <div class="message-header">Rubin</div>
                <div class="message-content">
                    <strong>Tips for better results:</strong><br><br>
                    • Be specific about what you want to build<br>
                    • Use <code>@file</code> to reference files in your workspace<br>
                    • Switch to <strong>Agent mode</strong> for multi-step tasks<br>
                    • Attach files using 📎 for context<br>
                    • Ask follow-up questions to refine the output
                </div>
            \`;
            messages.insertBefore(div, typing);
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
            // Remove any existing follow-ups first to avoid duplicates
            messages.querySelectorAll('.follow-ups').forEach(el => el.remove());
            
            // Deduplicate suggestions
            const uniqueSuggestions = [...new Set(suggestions)].slice(0, 3);
            if (uniqueSuggestions.length === 0) return;
            
            const container = document.createElement('div');
            container.className = 'follow-ups';
            container.innerHTML = uniqueSuggestions.map(s => 
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
            
            // For tool_call, we show the pending chip
            // For tool_result, we update the last chip to show success/failure
            if (step.type === 'tool_result') {
                // Find and update the last pending chip
                const lastChip = container.querySelector('.agent-step.step-tool_call:last-of-type');
                if (lastChip) {
                    lastChip.className = 'agent-step step-tool_result' + (step.result?.success ? '' : ' error');
                    const icon = step.result?.success ? '✓' : '✗';
                    lastChip.innerHTML = icon + ' ' + (step.toolName || 'action');
                    lastChip.title = step.result?.success 
                        ? (step.result.output || 'Success').substring(0, 200)
                        : (step.result?.error || 'Failed');
                    return;
                }
            }
            
            const chip = document.createElement('span');
            chip.className = 'agent-step step-' + step.type;
            
            const icon = step.type === 'tool_call' ? '⏳' : '✓';
            const label = step.toolName || 'action';
            chip.innerHTML = icon + ' ' + label;
            
            // Show params on hover for tool calls
            if (step.type === 'tool_call' && step.toolParams) {
                const paramSummary = Object.entries(step.toolParams)
                    .map(([k, v]) => k + ': ' + String(v).substring(0, 50))
                    .join('\\n');
                chip.title = paramSummary;
            }
            
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
                '<div class="file-chip"><span class="file-icon">📄</span>' + name + 
                '<button onclick="removeFile(\\x27' + name + '\\x27)" title="Remove">×</button></div>'
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
                    setProcessingState(data.isTyping);
                    typing.classList.toggle('visible', data.isTyping);
                    break;
                case 'agentStep':
                    if (data.step.type === 'approval_requested') {
                        addApprovalRequest(data.step);
                    } else if (data.step.type !== 'response') {
                        addAgentStep(data.step);
                    }
                    break;
                case 'agentStarted':
                    setProcessingState(true);
                    agentStatus.classList.add('visible');
                    break;
                case 'agentStopped':
                    setProcessingState(false);
                    agentStatus.classList.remove('visible');
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
