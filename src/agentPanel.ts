import * as vscode from 'vscode';
import { getAgentProvider, AgentStep } from './agentProvider';

export class AgentPanel {
    public static currentPanel: AgentPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;

        // Set the webview's initial html content
        this._update();

        // Listen for when the panel is disposed
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.type) {
                    case 'runTask':
                        await this._runAgentTask(message.task);
                        break;
                    case 'stop':
                        getAgentProvider().stop();
                        this._postMessage({ type: 'stopped' });
                        break;
                    case 'clear':
                        getAgentProvider().clearHistory();
                        this._postMessage({ type: 'cleared' });
                        break;
                }
            },
            null,
            this._disposables
        );

        // Set up agent event callback
        getAgentProvider().setEventCallback((step: AgentStep) => {
            this._postMessage({
                type: 'step',
                step: {
                    ...step,
                    timestamp: step.timestamp.toISOString(),
                },
            });
        });
    }

    public static createOrShow(extensionUri: vscode.Uri) {
        const column = vscode.ViewColumn.Beside;

        // If we already have a panel, show it
        if (AgentPanel.currentPanel) {
            AgentPanel.currentPanel._panel.reveal(column);
            return;
        }

        // Otherwise, create a new panel
        const panel = vscode.window.createWebviewPanel(
            'rubinAgent',
            '🤖 Rubin Agent',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri],
            }
        );

        AgentPanel.currentPanel = new AgentPanel(panel, extensionUri);
    }

    private async _runAgentTask(task: string) {
        const agent = getAgentProvider();

        if (agent.isAgentRunning()) {
            this._postMessage({
                type: 'error',
                message: 'Agent is already running a task',
            });
            return;
        }

        this._postMessage({ type: 'started' });

        try {
            const result = await agent.runTask(task);
            this._postMessage({
                type: 'completed',
                result: result,
            });
        } catch (error) {
            this._postMessage({
                type: 'error',
                message: error instanceof Error ? error.message : 'Unknown error',
            });
        }
    }

    private _postMessage(message: unknown) {
        this._panel.webview.postMessage(message);
    }

    private _update() {
        this._panel.webview.html = this._getHtmlForWebview();
    }

    private _getHtmlForWebview(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Rubin Agent</title>
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
            background: var(--vscode-editor-background);
            height: 100vh;
            display: flex;
            flex-direction: column;
            padding: 16px;
        }
        .header {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 16px;
            padding-bottom: 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .header h1 {
            font-size: 18px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .header-actions {
            margin-left: auto;
            display: flex;
            gap: 8px;
        }
        .btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            padding: 6px 12px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
        }
        .btn:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-danger {
            background: var(--vscode-inputValidation-errorBackground);
            color: var(--vscode-errorForeground);
        }
        .input-section {
            margin-bottom: 16px;
        }
        .input-wrapper {
            display: flex;
            gap: 8px;
        }
        textarea {
            flex: 1;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
            border-radius: 6px;
            padding: 12px;
            font-family: var(--vscode-font-family);
            font-size: 13px;
            resize: none;
            min-height: 80px;
        }
        textarea:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        textarea::placeholder {
            color: var(--vscode-input-placeholderForeground);
        }
        .steps-container {
            flex: 1;
            overflow-y: auto;
            background: var(--vscode-sideBar-background);
            border-radius: 8px;
            padding: 12px;
        }
        .step {
            padding: 12px;
            margin-bottom: 12px;
            border-radius: 6px;
            animation: fadeIn 0.2s ease;
        }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(5px); }
            to { opacity: 1; transform: translateY(0); }
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
        .step-tool_result.error {
            border-left-color: var(--vscode-errorForeground);
        }
        .step-response {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
        }
        .step-header {
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            margin-bottom: 6px;
            opacity: 0.8;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .step-content {
            font-size: 12px;
            line-height: 1.5;
            white-space: pre-wrap;
            word-break: break-word;
        }
        .step-content pre {
            background: var(--vscode-textCodeBlock-background);
            padding: 8px;
            border-radius: 4px;
            overflow-x: auto;
            font-family: var(--vscode-editor-font-family);
            font-size: 11px;
            margin-top: 8px;
        }
        .tool-params {
            background: var(--vscode-textCodeBlock-background);
            padding: 8px;
            border-radius: 4px;
            font-family: var(--vscode-editor-font-family);
            font-size: 11px;
            margin-top: 6px;
        }
        .status {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 12px;
            background: var(--vscode-inputValidation-infoBackground);
            border-radius: 6px;
            margin-bottom: 12px;
            font-size: 12px;
        }
        .status.hidden {
            display: none;
        }
        .spinner {
            width: 14px;
            height: 14px;
            border: 2px solid var(--vscode-foreground);
            border-top-color: transparent;
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        .welcome {
            text-align: center;
            padding: 40px;
            color: var(--vscode-descriptionForeground);
        }
        .welcome h2 {
            color: var(--vscode-foreground);
            margin-bottom: 8px;
        }
        .welcome p {
            margin-bottom: 16px;
        }
        .examples {
            display: flex;
            flex-direction: column;
            gap: 8px;
            margin-top: 16px;
        }
        .example {
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border, transparent);
            padding: 10px 14px;
            border-radius: 6px;
            cursor: pointer;
            text-align: left;
            font-size: 12px;
            transition: background 0.1s;
        }
        .example:hover {
            background: var(--vscode-list-hoverBackground);
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>🤖 Rubin Agent</h1>
        <div class="header-actions">
            <button class="btn btn-secondary" onclick="clearChat()">Clear</button>
            <button class="btn btn-danger" id="stopBtn" onclick="stopAgent()" disabled>Stop</button>
        </div>
    </div>

    <div class="input-section">
        <div class="input-wrapper">
            <textarea 
                id="taskInput" 
                placeholder="Describe what you want me to do... (e.g., 'Create a new React component called Button')"
                rows="3"
            ></textarea>
            <button class="btn" id="runBtn" onclick="runTask()">Run</button>
        </div>
    </div>

    <div class="status hidden" id="status">
        <div class="spinner"></div>
        <span id="statusText">Agent is working...</span>
    </div>

    <div class="steps-container" id="stepsContainer">
        <div class="welcome" id="welcome">
            <h2>👋 Welcome to Agent Mode!</h2>
            <p>I can autonomously complete coding tasks by reading files, writing code, and running commands.</p>
            <div class="examples">
                <button class="example" onclick="setTask('Create a new file called hello.ts with a function that returns Hello World')">
                    ✨ Create a new TypeScript file with a hello function
                </button>
                <button class="example" onclick="setTask('List all TypeScript files in the src folder and summarize what each one does')">
                    📁 Analyze all TypeScript files in src
                </button>
                <button class="example" onclick="setTask('Run npm test and explain any errors')">
                    🧪 Run tests and explain errors
                </button>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const taskInput = document.getElementById('taskInput');
        const runBtn = document.getElementById('runBtn');
        const stopBtn = document.getElementById('stopBtn');
        const status = document.getElementById('status');
        const statusText = document.getElementById('statusText');
        const stepsContainer = document.getElementById('stepsContainer');
        const welcome = document.getElementById('welcome');

        let isRunning = false;

        taskInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.ctrlKey) {
                e.preventDefault();
                runTask();
            }
        });

        function setTask(task) {
            taskInput.value = task;
            taskInput.focus();
        }

        function runTask() {
            const task = taskInput.value.trim();
            if (!task || isRunning) return;

            welcome.style.display = 'none';
            vscode.postMessage({ type: 'runTask', task });
        }

        function stopAgent() {
            vscode.postMessage({ type: 'stop' });
        }

        function clearChat() {
            stepsContainer.innerHTML = '';
            stepsContainer.appendChild(welcome);
            welcome.style.display = 'block';
            vscode.postMessage({ type: 'clear' });
        }

        function setRunning(running) {
            isRunning = running;
            runBtn.disabled = running;
            stopBtn.disabled = !running;
            status.classList.toggle('hidden', !running);
            if (!running) {
                taskInput.value = '';
            }
        }

        function addStep(step) {
            welcome.style.display = 'none';

            const stepDiv = document.createElement('div');
            stepDiv.className = 'step step-' + step.type;
            
            if (step.type === 'tool_result' && step.result && !step.result.success) {
                stepDiv.classList.add('error');
            }

            const header = document.createElement('div');
            header.className = 'step-header';
            
            const icons = {
                thinking: '🧠',
                tool_call: '🔧',
                tool_result: step.result?.success ? '✅' : '❌',
                response: '💬'
            };
            
            const labels = {
                thinking: 'Thinking',
                tool_call: 'Tool Call: ' + (step.toolName || ''),
                tool_result: (step.result?.success ? 'Success' : 'Error') + ': ' + (step.toolName || ''),
                response: 'Response'
            };

            header.innerHTML = icons[step.type] + ' ' + labels[step.type];

            const content = document.createElement('div');
            content.className = 'step-content';
            
            if (step.type === 'tool_call' && step.toolParams) {
                content.innerHTML = '<div class="tool-params">' + 
                    escapeHtml(JSON.stringify(step.toolParams, null, 2)) + '</div>';
            } else if (step.type === 'tool_result') {
                const output = step.result?.success ? step.result.output : step.result?.error;
                content.innerHTML = '<pre>' + escapeHtml(output || '') + '</pre>';
            } else {
                content.textContent = step.content;
            }

            stepDiv.appendChild(header);
            stepDiv.appendChild(content);
            stepsContainer.appendChild(stepDiv);
            stepsContainer.scrollTop = stepsContainer.scrollHeight;
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        window.addEventListener('message', (event) => {
            const data = event.data;
            switch (data.type) {
                case 'started':
                    setRunning(true);
                    statusText.textContent = 'Agent is working...';
                    break;
                case 'step':
                    addStep(data.step);
                    if (data.step.type === 'thinking') {
                        statusText.textContent = data.step.content;
                    } else if (data.step.type === 'tool_call') {
                        statusText.textContent = 'Running ' + data.step.toolName + '...';
                    }
                    break;
                case 'completed':
                    setRunning(false);
                    break;
                case 'stopped':
                    setRunning(false);
                    addStep({
                        type: 'response',
                        content: 'Agent stopped by user.',
                        timestamp: new Date().toISOString()
                    });
                    break;
                case 'error':
                    setRunning(false);
                    addStep({
                        type: 'tool_result',
                        content: data.message,
                        result: { success: false, output: '', error: data.message },
                        timestamp: new Date().toISOString()
                    });
                    break;
                case 'cleared':
                    // Already handled in clearChat
                    break;
            }
        });
    </script>
</body>
</html>`;
    }

    public dispose() {
        AgentPanel.currentPanel = undefined;

        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
}
