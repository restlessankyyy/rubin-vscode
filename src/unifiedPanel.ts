import * as vscode from 'vscode';
import * as path from 'path';
import { getConfig, setModel } from './config';
import { getOllamaClient } from './ollamaClient';
import { getAgentProvider, AgentStep } from './agentProvider';

export class UnifiedPanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'rubin.unifiedView';
    private _view?: vscode.WebviewView;
    private _conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    private _attachedFiles: Array<{ name: string; content: string; language: string }> = [];
    private _currentMode: 'chat' | 'agent' = 'chat';

    constructor(private readonly _extensionUri: vscode.Uri) { }

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
        // Add user message to history
        this._conversationHistory.push({ role: 'user', content: message });
        this._postMessage({ type: 'userMessage', content: message });
        this._postMessage({ type: 'typing', isTyping: true });

        try {
            const config = getConfig();
            const client = getOllamaClient(config.serverUrl);

            // Build context from attached files
            let context = '';
            for (const file of this._attachedFiles) {
                context += `\n\nFile: ${file.name}\n\`\`\`${file.language}\n${file.content}\n\`\`\``;
            }

            // Get current editor context if no files attached
            if (this._attachedFiles.length === 0) {
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    const selection = editor.selection;
                    const selectedText = editor.document.getText(selection);
                    if (selectedText) {
                        context = `\n\nSelected code:\n\`\`\`${editor.document.languageId}\n${selectedText}\n\`\`\``;
                    } else {
                        const currentLine = editor.selection.active.line;
                        const startLine = Math.max(0, currentLine - 10);
                        const endLine = Math.min(editor.document.lineCount - 1, currentLine + 10);
                        const range = new vscode.Range(startLine, 0, endLine, editor.document.lineAt(endLine).text.length);
                        context = `\n\nCurrent file (${path.basename(editor.document.fileName)}):\n\`\`\`${editor.document.languageId}\n${editor.document.getText(range)}\n\`\`\``;
                    }
                }
            }

            const prompt = this._buildChatPrompt(message, context);
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
        } catch (error) {
            this._postMessage({
                type: 'error',
                content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
            });
        } finally {
            this._postMessage({ type: 'typing', isTyping: false });
        }
    }

    private async _handleAgentMessage(message: string) {
        this._postMessage({ type: 'userMessage', content: message });
        this._postMessage({ type: 'agentStarted' });

        try {
            const agent = getAgentProvider();

            // Add file context to message if files are attached
            let fullMessage = message;
            if (this._attachedFiles.length > 0) {
                fullMessage += '\n\nContext files:';
                for (const file of this._attachedFiles) {
                    fullMessage += `\n\nFile: ${file.name}\n\`\`\`${file.language}\n${file.content}\n\`\`\``;
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
        const systemPrompt = `You are Rubin, a helpful AI coding assistant. You help developers write, understand, and debug code. Be concise but thorough. Format code blocks with proper markdown syntax.`;

        let prompt = systemPrompt + '\n\n';

        for (const msg of this._conversationHistory.slice(-6)) {
            if (msg.role === 'user') {
                prompt += `User: ${msg.content}\n\n`;
            } else {
                prompt += `Assistant: ${msg.content}\n\n`;
            }
        }

        if (context) {
            prompt += context + '\n\n';
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
        
        /* Agent Steps */
        .agent-step {
            padding: 8px 10px;
            margin-bottom: 8px;
            border-radius: 6px;
            font-size: 12px;
        }
        .step-thinking {
            background: var(--vscode-inputValidation-infoBackground);
            border-left: 3px solid var(--vscode-inputValidation-infoBorder);
        }
        .step-tool_call {
            background: var(--vscode-inputValidation-warningBackground);
            border-left: 3px solid var(--vscode-inputValidation-warningBorder);
        }
        .step-tool_result {
            background: var(--vscode-input-background);
            border-left: 3px solid var(--vscode-charts-green);
        }
        .step-tool_result.error { border-left-color: var(--vscode-errorForeground); }
        .step-header {
            font-size: 10px;
            font-weight: 600;
            text-transform: uppercase;
            margin-bottom: 4px;
            opacity: 0.8;
        }
        .step-content { white-space: pre-wrap; font-size: 11px; }
        
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
    </style>
</head>
<body>
    <div class="header">
        <h3>🤖 Rubin</h3>
        <div class="header-actions">
            <button class="icon-btn" onclick="clearChat()" title="Clear chat">🗑️</button>
        </div>
    </div>

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
        }

        function addAgentStep(step) {
            welcome.style.display = 'none';
            const div = document.createElement('div');
            let className = 'agent-step step-' + step.type;
            if (step.type === 'tool_result' && step.result && !step.result.success) {
                className += ' error';
            }
            div.className = className;
            
            const icons = { thinking: '🧠', tool_call: '🔧', tool_result: step.result?.success ? '✅' : '❌' };
            const labels = { 
                thinking: 'Thinking', 
                tool_call: step.toolName || 'Tool Call',
                tool_result: step.toolName || 'Result'
            };
            
            let content = step.content;
            if (step.type === 'tool_call' && step.toolParams) {
                content = JSON.stringify(step.toolParams, null, 2);
            } else if (step.type === 'tool_result' && step.result) {
                content = step.result.success ? step.result.output : step.result.error;
            }
            
            div.innerHTML = '<div class="step-header">' + (icons[step.type] || '') + ' ' + labels[step.type] + '</div>' +
                '<div class="step-content">' + escapeHtml(content || '') + '</div>';
            messages.insertBefore(div, typing);
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
                '<button onclick="removeFile(\\\'' + name + '\\')"">×</button></div>'
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
                    if (data.step.type !== 'response') addAgentStep(data.step);
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
            }
        });
    </script>
</body>
</html>`;
    }
}
