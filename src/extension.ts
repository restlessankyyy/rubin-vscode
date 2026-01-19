import * as vscode from 'vscode';
import { LocalCopilotCompletionProvider } from './completionProvider';
import { getConfig, setEnabled, setModel, onConfigChange } from './config';
import { getOllamaClient } from './ollamaClient';
import { UnifiedPanelProvider } from './unifiedPanel';

let statusBarItem: vscode.StatusBarItem;
let completionProvider: LocalCopilotCompletionProvider;
let unifiedPanel: UnifiedPanelProvider;

export function activate(context: vscode.ExtensionContext) {
    console.log('Rubin is now active!');

    const config = getConfig();

    // Create and register the completion provider
    completionProvider = new LocalCopilotCompletionProvider();

    const providerDisposable = vscode.languages.registerInlineCompletionItemProvider(
        { pattern: '**' }, // All file types
        completionProvider
    );
    context.subscriptions.push(providerDisposable);

    // Create and register the unified panel (chat + agent)
    unifiedPanel = new UnifiedPanelProvider(context.extensionUri);
    const unifiedViewDisposable = vscode.window.registerWebviewViewProvider(
        UnifiedPanelProvider.viewType,
        unifiedPanel
    );
    context.subscriptions.push(unifiedViewDisposable);

    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    statusBarItem.command = 'rubin.toggle';
    context.subscriptions.push(statusBarItem);

    // Update status bar
    updateStatusBar(config.enabled, config.model);
    statusBarItem.show();

    // Register commands
    const toggleCommand = vscode.commands.registerCommand('rubin.toggle', async () => {
        const currentConfig = getConfig();
        const newEnabled = !currentConfig.enabled;
        await setEnabled(newEnabled);
        updateStatusBar(newEnabled, currentConfig.model);
        vscode.window.showInformationMessage(
            `Rubin ${newEnabled ? 'enabled' : 'disabled'}`
        );
    });
    context.subscriptions.push(toggleCommand);

    const selectModelCommand = vscode.commands.registerCommand('rubin.selectModel', async () => {
        const client = getOllamaClient(getConfig().serverUrl);
        const models = await client.getAvailableModels();

        if (models.length === 0) {
            vscode.window.showWarningMessage(
                'No models found. Make sure Ollama is running and has models installed.'
            );
            return;
        }

        const selected = await vscode.window.showQuickPick(models, {
            placeHolder: 'Select a model for code completion',
            title: 'Rubin: Select Model'
        });

        if (selected) {
            await setModel(selected);
            updateStatusBar(getConfig().enabled, selected);
            vscode.window.showInformationMessage(`Model changed to ${selected}`);
        }
    });
    context.subscriptions.push(selectModelCommand);

    const checkConnectionCommand = vscode.commands.registerCommand('rubin.checkConnection', async () => {
        const currentConfig = getConfig();
        const client = getOllamaClient(currentConfig.serverUrl);

        const statusMessage = vscode.window.setStatusBarMessage('Checking Ollama connection...');

        const connected = await client.checkConnection();
        statusMessage.dispose();

        if (connected) {
            const models = await client.getAvailableModels();
            vscode.window.showInformationMessage(
                `✅ Connected to Ollama at ${currentConfig.serverUrl}. Available models: ${models.join(', ')}`
            );
        } else {
            vscode.window.showErrorMessage(
                `❌ Cannot connect to Ollama at ${currentConfig.serverUrl}. Make sure Ollama is running with 'ollama serve'.`
            );
        }
    });
    context.subscriptions.push(checkConnectionCommand);

    // Command to open unified panel
    const openChatCommand = vscode.commands.registerCommand('rubin.openChat', () => {
        vscode.commands.executeCommand('rubin.unifiedView.focus');
    });
    context.subscriptions.push(openChatCommand);

    // Command to ask about selected code
    const askAboutCodeCommand = vscode.commands.registerCommand('rubin.askAboutCode', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const selection = editor.selection;
            const selectedText = editor.document.getText(selection);
            if (selectedText) {
                unifiedPanel.addCodeToChat(selectedText, editor.document.languageId);
                vscode.commands.executeCommand('rubin.unifiedView.focus');
            } else {
                vscode.window.showInformationMessage('Select some code first to ask about it.');
            }
        }
    });
    context.subscriptions.push(askAboutCodeCommand);

    // Command to start agent mode (opens unified panel in agent mode)
    const startAgentCommand = vscode.commands.registerCommand('rubin.startAgent', () => {
        vscode.commands.executeCommand('rubin.unifiedView.focus');
    });
    context.subscriptions.push(startAgentCommand);

    // Listen for configuration changes
    const configChangeDisposable = onConfigChange((newConfig) => {
        completionProvider.updateConfig(newConfig);
        updateStatusBar(newConfig.enabled, newConfig.model);
    });
    context.subscriptions.push(configChangeDisposable);

    // Initial connection check (non-blocking)
    checkConnectionOnStartup();
}

function updateStatusBar(enabled: boolean, model: string): void {
    if (enabled) {
        statusBarItem.text = `$(hubot) ${model}`;
        statusBarItem.tooltip = `Rubin: ${model} (click to toggle)`;
        statusBarItem.backgroundColor = undefined;
    } else {
        statusBarItem.text = `$(hubot) Disabled`;
        statusBarItem.tooltip = 'Rubin: Disabled (click to enable)';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
}

async function checkConnectionOnStartup(): Promise<void> {
    const config = getConfig();
    const client = getOllamaClient(config.serverUrl);

    const connected = await client.checkConnection();

    if (!connected) {
        const action = await vscode.window.showWarningMessage(
            'Rubin: Cannot connect to Ollama. Make sure it\'s running.',
            'Check Connection',
            'Open Settings'
        );

        if (action === 'Check Connection') {
            vscode.commands.executeCommand('rubin.checkConnection');
        } else if (action === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'rubin');
        }
    }
}

export function deactivate() {
    console.log('Rubin deactivated');
}
