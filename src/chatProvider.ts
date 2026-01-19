import * as vscode from 'vscode';
import { getConfig, setModel } from './config';
import { getOllamaClient } from './ollamaClient';

export class RubinChatProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'rubin.chatView';
    private _view?: vscode.WebviewView;
    private _conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];

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

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'sendMessage':
                    await this._handleUserMessage(data.message);
                    break;
                case 'clearChat':
                    this._conversationHistory = [];
                    this._postMessage({ type: 'cleared' });
                    break;
                case 'getModels':
                    await this._loadModels();
                    break;
                case 'changeModel':
                    await setModel(data.model);
                    vscode.window.showInformationMessage(`Model changed to ${data.model}`);
                    break;
            }
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

    private async _handleUserMessage(message: string) {
        // Add user message to history
        this._conversationHistory.push({ role: 'user', content: message });

        // Show user message in chat
        this._postMessage({ type: 'userMessage', content: message });

        // Show typing indicator
        this._postMessage({ type: 'typing', isTyping: true });

        try {
            const config = getConfig();
            const client = getOllamaClient(config.serverUrl);

            // Get current editor context if available
            const editor = vscode.window.activeTextEditor;
            let context = '';
            if (editor) {
                const selection = editor.selection;
                const selectedText = editor.document.getText(selection);
                if (selectedText) {
                    context = `\n\nSelected code:\n\`\`\`${editor.document.languageId}\n${selectedText}\n\`\`\``;
                } else {
                    // Get surrounding context
                    const currentLine = editor.selection.active.line;
                    const startLine = Math.max(0, currentLine - 10);
                    const endLine = Math.min(editor.document.lineCount - 1, currentLine + 10);
                    const range = new vscode.Range(startLine, 0, endLine, editor.document.lineAt(endLine).text.length);
                    context = `\n\nCurrent file (${editor.document.fileName.split('/').pop()}):\n\`\`\`${editor.document.languageId}\n${editor.document.getText(range)}\n\`\`\``;
                }
            }

            // Build conversation prompt
            const prompt = this._buildChatPrompt(message, context);

            // Generate response
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
            console.error('Chat error:', error);
            this._postMessage({
                type: 'error',
                content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
            });
        } finally {
            this._postMessage({ type: 'typing', isTyping: false });
        }
    }

    private _buildChatPrompt(message: string, context: string): string {
        const systemPrompt = `You are Rubin, a helpful AI coding assistant. You help developers write, understand, and debug code. Be concise but thorough. Format code blocks with proper markdown syntax.`;

        // Build conversation history
        let prompt = systemPrompt + '\n\n';

        for (const msg of this._conversationHistory.slice(-6)) { // Keep last 6 messages for context
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

    private _getHtmlForWebview(_webview: vscode.Webview): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Rubin Chat</title>
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background);
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        .header {
            padding: 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .header h3 {
            font-size: 13px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .header h3::before {
            content: "🤖";
        }
        .clear-btn {
            background: transparent;
            border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, transparent));
            color: var(--vscode-foreground);
            padding: 4px 8px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 11px;
        }
        .clear-btn:hover {
            background: var(--vscode-toolbar-hoverBackground);
        }
        .chat-container {
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
            padding: 10px;
            border-radius: 4px;
            overflow-x: auto;
            margin: 8px 0;
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
        }
        .message-content code {
            background: var(--vscode-textCodeBlock-background);
            padding: 2px 5px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
        }
        .message-content pre code {
            background: none;
            padding: 0;
        }
        .typing-indicator {
            display: none;
            padding: 10px 12px;
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }
        .typing-indicator.visible {
            display: block;
        }
        .typing-indicator::after {
            content: '';
            animation: dots 1.5s infinite;
        }
        @keyframes dots {
            0%, 20% { content: '.'; }
            40% { content: '..'; }
            60%, 100% { content: '...'; }
        }
        .input-container {
            padding: 12px;
            border-top: 1px solid var(--vscode-panel-border);
        }
        .toolbar {
            display: flex;
            gap: 8px;
            margin-bottom: 8px;
            align-items: center;
        }
        .toolbar select {
            flex: 1;
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, transparent));
            border-radius: 4px;
            padding: 4px 8px;
            font-size: 11px;
            cursor: pointer;
        }
        .toolbar select:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        .toolbar-btn {
            background: transparent;
            border: 1px solid var(--vscode-button-border, transparent);
            color: var(--vscode-foreground);
            padding: 4px 8px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }
        .toolbar-btn:hover {
            background: var(--vscode-toolbar-hoverBackground);
        }
        .input-wrapper {
            display: flex;
            gap: 8px;
        }
        textarea {
            flex: 1;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, transparent);
            border-radius: 4px;
            padding: 8px 10px;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            resize: none;
            min-height: 60px;
            max-height: 150px;
        }
        textarea:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        textarea::placeholder {
            color: var(--vscode-input-placeholderForeground);
        }
        .send-btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            padding: 8px 16px;
            cursor: pointer;
            font-weight: 500;
            align-self: flex-end;
        }
        .send-btn:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .send-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .welcome {
            text-align: center;
            padding: 40px 20px;
            color: var(--vscode-descriptionForeground);
        }
        .welcome h2 {
            margin-bottom: 8px;
            color: var(--vscode-foreground);
        }
        .welcome p {
            font-size: 12px;
            margin-bottom: 20px;
        }
        .suggestions {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .suggestion {
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border, transparent);
            padding: 10px;
            border-radius: 6px;
            cursor: pointer;
            text-align: left;
            font-size: 12px;
        }
        .suggestion:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .error {
            color: var(--vscode-errorForeground);
            background: var(--vscode-inputValidation-errorBackground);
            padding: 8px 12px;
            border-radius: 4px;
            margin-bottom: 12px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h3>Rubin Chat</h3>
        <button class="clear-btn" onclick="clearChat()">Clear</button>
    </div>
    
    <div class="chat-container" id="chatContainer">
        <div class="welcome" id="welcome">
            <h2>👋 Hey there!</h2>
            <p>I'm Rubin, your AI coding assistant. Ask me anything!</p>
            <div class="suggestions">
                <button class="suggestion" onclick="sendSuggestion('Explain the selected code')">💡 Explain the selected code</button>
                <button class="suggestion" onclick="sendSuggestion('Help me fix this bug')">🐛 Help me fix this bug</button>
                <button class="suggestion" onclick="sendSuggestion('Write tests for this function')">🧪 Write tests for this function</button>
                <button class="suggestion" onclick="sendSuggestion('Refactor this code to be more readable')">✨ Refactor for readability</button>
            </div>
        </div>
        <div class="typing-indicator" id="typingIndicator">Rubin is thinking</div>
    </div>
    
    <div class="input-container">
        <div class="toolbar">
            <select id="modelSelect" onchange="changeModel(this.value)">
                <option value="">Loading models...</option>
            </select>
            <button class="toolbar-btn" onclick="refreshModels()" title="Refresh models">🔄</button>
        </div>
        <div class="input-wrapper">
            <textarea 
                id="messageInput" 
                placeholder="Ask Rubin anything... (Shift+Enter for new line)"
                rows="2"
            ></textarea>
            <button class="send-btn" id="sendBtn" onclick="sendMessage()">Send</button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const chatContainer = document.getElementById('chatContainer');
        const messageInput = document.getElementById('messageInput');
        const sendBtn = document.getElementById('sendBtn');
        const typingIndicator = document.getElementById('typingIndicator');
        const welcome = document.getElementById('welcome');
        
        let isWaiting = false;

        messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        function sendMessage() {
            const message = messageInput.value.trim();
            if (!message || isWaiting) return;
            
            vscode.postMessage({ type: 'sendMessage', message });
            messageInput.value = '';
            messageInput.style.height = 'auto';
        }

        function sendSuggestion(text) {
            messageInput.value = text;
            sendMessage();
        }

        function clearChat() {
            vscode.postMessage({ type: 'clearChat' });
        }

        function changeModel(model) {
            if (model) {
                vscode.postMessage({ type: 'changeModel', model });
            }
        }

        function refreshModels() {
            vscode.postMessage({ type: 'getModels' });
        }

        function updateModelSelector(models, currentModel) {
            const select = document.getElementById('modelSelect');
            select.innerHTML = '';
            
            if (models.length === 0) {
                const option = document.createElement('option');
                option.value = '';
                option.textContent = 'No models found';
                select.appendChild(option);
                return;
            }
            
            models.forEach(model => {
                const option = document.createElement('option');
                option.value = model;
                option.textContent = model;
                if (model === currentModel) {
                    option.selected = true;
                }
                select.appendChild(option);
            });
        }

        function addMessage(role, content) {
            if (welcome) welcome.style.display = 'none';
            
            const messageDiv = document.createElement('div');
            messageDiv.className = \`message \${role}-message\`;
            
            const header = document.createElement('div');
            header.className = 'message-header';
            header.textContent = role === 'user' ? 'You' : 'Rubin';
            
            const contentDiv = document.createElement('div');
            contentDiv.className = 'message-content';
            contentDiv.innerHTML = formatContent(content);
            
            messageDiv.appendChild(header);
            messageDiv.appendChild(contentDiv);
            
            chatContainer.insertBefore(messageDiv, typingIndicator);
            chatContainer.scrollTop = chatContainer.scrollHeight;
        }

        function formatContent(content) {
            // Escape HTML
            let formatted = content
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
            
            // Format code blocks
            formatted = formatted.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, '<pre><code>$2</code></pre>');
            
            // Format inline code
            formatted = formatted.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
            
            // Format newlines
            formatted = formatted.replace(/\\n/g, '<br>');
            
            return formatted;
        }

        function showError(message) {
            const errorDiv = document.createElement('div');
            errorDiv.className = 'error';
            errorDiv.textContent = message;
            chatContainer.insertBefore(errorDiv, typingIndicator);
            chatContainer.scrollTop = chatContainer.scrollHeight;
        }

        // Handle messages from extension
        window.addEventListener('message', (event) => {
            const data = event.data;
            switch (data.type) {
                case 'userMessage':
                    addMessage('user', data.content);
                    break;
                case 'assistantMessage':
                    addMessage('assistant', data.content);
                    break;
                case 'typing':
                    isWaiting = data.isTyping;
                    typingIndicator.classList.toggle('visible', data.isTyping);
                    sendBtn.disabled = data.isTyping;
                    if (data.isTyping) {
                        chatContainer.scrollTop = chatContainer.scrollHeight;
                    }
                    break;
                case 'error':
                    showError(data.content);
                    break;
                case 'cleared':
                    chatContainer.innerHTML = '';
                    chatContainer.appendChild(welcome);
                    welcome.style.display = 'block';
                    chatContainer.appendChild(typingIndicator);
                    break;
                case 'addCode':
                    messageInput.value = \`Regarding this code:\\n\\\`\\\`\\\`\${data.language}\\n\${data.code}\\n\\\`\\\`\\\`\\n\\n\`;
                    messageInput.focus();
                    break;
                case 'modelsLoaded':
                    updateModelSelector(data.models, data.currentModel);
                    break;
            }
        });

        // Auto-resize textarea
        messageInput.addEventListener('input', () => {
            messageInput.style.height = 'auto';
            messageInput.style.height = Math.min(messageInput.scrollHeight, 150) + 'px';
        });
    </script>
</body>
</html>`;
    }
}
