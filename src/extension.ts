import * as vscode from 'vscode';
import { LocalCopilotCompletionProvider } from './completionProvider';
import { getConfig, setEnabled, setModel, onConfigChange } from './config';
import { getOllamaClient } from './ollamaClient';
import { UnifiedPanelProvider } from './unifiedPanel';
import { logger } from './logger';
import { registerCodeActionProvider, registerCodeActionCommands } from './codeActions';
import { registerInlineChatCommands } from './inlineChat';
import { registerGitCommands } from './gitIntegration';
import { getWorkspaceIndexer } from './workspaceIndexer';
import { getMCPManager, disposeMCPManager } from './mcpClient';

let statusBarItem: vscode.StatusBarItem;
let completionProvider: LocalCopilotCompletionProvider;
let unifiedPanel: UnifiedPanelProvider;

export function activate(context: vscode.ExtensionContext) {
    // Initialize logger first
    logger.init(context);
    logger.info('Rubin extension activating...');

    try {
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

    // Register code actions (Explain, Fix, Generate Tests, etc.)
    registerCodeActionProvider(context);
    registerCodeActionCommands(context, (message) => {
        unifiedPanel.sendMessageToChat(message);
    });

    // Register inline chat (edit in place)
    registerInlineChatCommands(context);

    // Register git commands (commit message generation)
    registerGitCommands(context);

    // Start workspace indexing in background
    getWorkspaceIndexer().buildIndex().catch(err => {
        logger.warn('Failed to build workspace index', err);
    });

    // Initialize MCP servers from configuration
    initializeMCPServers();

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

    // MCP Server management commands
    const manageMCPCommand = vscode.commands.registerCommand('rubin.manageMCPServers', async () => {
        const mcpManager = getMCPManager();
        const servers = mcpManager.getServers();
        
        if (servers.length === 0) {
            const action = await vscode.window.showInformationMessage(
                'No MCP servers configured. Would you like to add one?',
                'Open Settings',
                'Learn More'
            );
            if (action === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'rubin.mcpServers');
            } else if (action === 'Learn More') {
                vscode.env.openExternal(vscode.Uri.parse('https://modelcontextprotocol.io/'));
            }
            return;
        }

        const items = servers.map(server => ({
            label: `$(${server.isConnected() ? 'check' : 'circle-slash'}) ${server.name}`,
            description: server.isConnected() ? 'Connected' : 'Disconnected',
            server
        }));

        items.push({
            label: '$(add) Add New Server...',
            description: 'Configure a new MCP server',
            server: null as any
        });

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select an MCP server to manage'
        });

        if (selected) {
            if (!selected.server) {
                vscode.commands.executeCommand('workbench.action.openSettings', 'rubin.mcpServers');
                return;
            }

            const actions = selected.server.isConnected()
                ? ['Show Tools', 'Disconnect', 'View Logs']
                : ['Connect', 'Remove', 'View Logs'];

            const action = await vscode.window.showQuickPick(actions, {
                placeHolder: `Actions for ${selected.server.name}`
            });

            if (action === 'Connect') {
                await selected.server.connect();
                vscode.window.showInformationMessage(`Connected to ${selected.server.name}`);
            } else if (action === 'Disconnect') {
                selected.server.disconnect();
                vscode.window.showInformationMessage(`Disconnected from ${selected.server.name}`);
            } else if (action === 'Show Tools') {
                const tools = selected.server.getTools();
                if (tools.length === 0) {
                    vscode.window.showInformationMessage(`${selected.server.name} has no tools available`);
                } else {
                    const toolItems = tools.map(t => ({
                        label: t.name,
                        description: t.description
                    }));
                    await vscode.window.showQuickPick(toolItems, {
                        placeHolder: `Tools from ${selected.server.name}`,
                        canPickMany: false
                    });
                }
            } else if (action === 'View Logs') {
                logger.show();
            }
        }
    });
    context.subscriptions.push(manageMCPCommand);

    const refreshMCPCommand = vscode.commands.registerCommand('rubin.refreshMCPServers', async () => {
        await initializeMCPServers();
        vscode.window.showInformationMessage('MCP servers refreshed');
    });
    context.subscriptions.push(refreshMCPCommand);

    // Listen for configuration changes
    const configChangeDisposable = onConfigChange((newConfig) => {
        completionProvider.updateConfig(newConfig);
        updateStatusBar(newConfig.enabled, newConfig.model);
        logger.debug('Configuration updated', newConfig);
        
        // Refresh MCP servers when config changes
        initializeMCPServers();
    });
    context.subscriptions.push(configChangeDisposable);

    // Initial connection check (non-blocking)
    checkConnectionOnStartup();

    logger.info('Rubin extension activated successfully');
    } catch (error) {
        logger.error('Failed to activate Rubin extension', error);
        throw error;
    }
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

    logger.debug(`Checking connection to Ollama at ${config.serverUrl}`);
    const connected = await client.checkConnection();

    if (!connected) {
        logger.warn('Cannot connect to Ollama on startup');
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
    } else {
        logger.info('Successfully connected to Ollama');
    }
}

async function initializeMCPServers(): Promise<void> {
    try {
        const mcpManager = getMCPManager();
        await mcpManager.loadServersFromConfig();
        
        const servers = mcpManager.getServers();
        const connectedCount = servers.filter(s => s.isConnected()).length;
        
        if (servers.length > 0) {
            logger.info(`MCP: ${connectedCount}/${servers.length} servers connected`);
        }
    } catch (error) {
        logger.error('Failed to initialize MCP servers', error);
    }
}

export function deactivate() {
    disposeMCPManager();
    logger.info('Rubin extension deactivated');
}
