import * as vscode from 'vscode';

export interface LocalCopilotConfig {
    enabled: boolean;
    serverUrl: string;
    model: string;
    maxTokens: number;
    temperature: number;
    debounceMs: number;
    contextLines: number;
}

const CONFIG_SECTION = 'rubin';
const API_KEY_SECRET = 'rubin.anthropicApiKey';

export function getConfig(): LocalCopilotConfig {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);

    return {
        enabled: config.get<boolean>('enabled', true),
        serverUrl: config.get<string>('serverUrl', 'http://localhost:11434'),
        model: config.get<string>('model', 'qwen3-coder:latest'),
        maxTokens: config.get<number>('maxTokens', 150),
        temperature: config.get<number>('temperature', 0.2),
        debounceMs: config.get<number>('debounceMs', 300),
        contextLines: config.get<number>('contextLines', 50),
    };
}

export async function setEnabled(enabled: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    await config.update('enabled', enabled, vscode.ConfigurationTarget.Global);
}

export async function setModel(model: string): Promise<void> {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    await config.update('model', model, vscode.ConfigurationTarget.Global);
}

export function onConfigChange(callback: (config: LocalCopilotConfig) => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(CONFIG_SECTION)) {
            callback(getConfig());
        }
    });
}

// ─── Anthropic API Key (SecretStorage — encrypted, not in settings.json) ───

export async function getAnthropicApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
    return context.secrets.get(API_KEY_SECRET);
}

export async function setAnthropicApiKey(context: vscode.ExtensionContext, key: string): Promise<void> {
    await context.secrets.store(API_KEY_SECRET, key);
}

export async function deleteAnthropicApiKey(context: vscode.ExtensionContext): Promise<void> {
    await context.secrets.delete(API_KEY_SECRET);
}
