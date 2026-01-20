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

export function getConfig(): LocalCopilotConfig {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);

    return {
        enabled: config.get<boolean>('enabled', true),
        serverUrl: config.get<string>('serverUrl', 'http://localhost:11434'),
        model: config.get<string>('model', 'llama3.1:8b'),
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
