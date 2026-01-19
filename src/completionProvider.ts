import * as vscode from 'vscode';
import { getConfig, LocalCopilotConfig } from './config';
import { getOllamaClient, OllamaClient } from './ollamaClient';

export class LocalCopilotCompletionProvider implements vscode.InlineCompletionItemProvider {
    private client: OllamaClient;
    private config: LocalCopilotConfig;
    private debounceTimer: NodeJS.Timeout | null = null;
    private lastRequestTime: number = 0;

    constructor() {
        this.config = getConfig();
        this.client = getOllamaClient(this.config.serverUrl);
    }

    updateConfig(config: LocalCopilotConfig): void {
        this.config = config;
        this.client.updateServerUrl(config.serverUrl);
    }

    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[] | null> {
        // Check if extension is enabled
        if (!this.config.enabled) {
            return null;
        }

        // Don't trigger on automatic invocations too frequently
        if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
            const now = Date.now();
            if (now - this.lastRequestTime < this.config.debounceMs) {
                return null;
            }
            this.lastRequestTime = now;
        }

        // Cancel any pending requests
        this.client.cancelPendingRequests();

        // Build the prompt from document context
        const prompt = this.buildPrompt(document, position);
        if (!prompt) {
            return null;
        }

        // Create abort controller for this request
        const abortController = new AbortController();

        // Listen for cancellation
        token.onCancellationRequested(() => {
            abortController.abort();
        });

        try {
            const completion = await this.client.generateCompletion(
                prompt,
                this.config,
                abortController.signal
            );

            if (!completion || token.isCancellationRequested) {
                return null;
            }

            // Create inline completion item
            const completionItem = new vscode.InlineCompletionItem(
                completion,
                new vscode.Range(position, position)
            );

            return [completionItem];
        } catch (error) {
            console.error('Error generating completion:', error);
            return null;
        }
    }

    private buildPrompt(document: vscode.TextDocument, position: vscode.Position): string | null {
        const languageId = document.languageId;
        const fileName = document.fileName.split('/').pop() || 'file';

        // Get lines before cursor (context)
        const startLine = Math.max(0, position.line - this.config.contextLines);
        const prefixRange = new vscode.Range(startLine, 0, position.line, position.character);
        const prefix = document.getText(prefixRange);

        // Get a few lines after cursor for additional context
        const endLine = Math.min(document.lineCount - 1, position.line + 5);
        const suffixRange = new vscode.Range(position.line, position.character, endLine, document.lineAt(endLine).text.length);
        const suffix = document.getText(suffixRange);

        // Skip if prefix is too short
        if (prefix.trim().length < 3) {
            return null;
        }

        // Build a fill-in-the-middle style prompt
        const prompt = this.formatPromptForModel(languageId, fileName, prefix, suffix);

        return prompt;
    }

    private formatPromptForModel(
        languageId: string,
        fileName: string,
        prefix: string,
        suffix: string
    ): string {
        // Different prompt formats work better for different models
        // This is a general format that works reasonably well with most code models

        const languageComment = this.getLanguageComment(languageId);

        // For fill-in-the-middle (FIM) capable models like codellama
        if (this.config.model.includes('codellama') || this.config.model.includes('deepseek')) {
            // CodeLlama FIM format
            return `<PRE> ${prefix} <SUF>${suffix} <MID>`;
        }

        // For general models, use a completion-style prompt
        return `${languageComment} File: ${fileName}
${languageComment} Language: ${languageId}
${languageComment} Complete the following code:

${prefix}`;
    }

    private getLanguageComment(languageId: string): string {
        const commentStyles: Record<string, string> = {
            'javascript': '//',
            'typescript': '//',
            'javascriptreact': '//',
            'typescriptreact': '//',
            'java': '//',
            'c': '//',
            'cpp': '//',
            'csharp': '//',
            'go': '//',
            'rust': '//',
            'swift': '//',
            'kotlin': '//',
            'scala': '//',
            'python': '#',
            'ruby': '#',
            'perl': '#',
            'bash': '#',
            'shell': '#',
            'powershell': '#',
            'r': '#',
            'lua': '--',
            'sql': '--',
            'haskell': '--',
            'html': '<!--',
            'css': '/*',
            'scss': '//',
            'less': '//',
        };

        return commentStyles[languageId] || '//';
    }
}
