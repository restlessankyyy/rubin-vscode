import * as vscode from 'vscode';
import { getConfig } from './config';
import { getOllamaClient } from './ollamaClient';
import { logger } from './logger';

/**
 * Provides inline editing capabilities - edit code in place with AI
 */
export class InlineChatProvider {
    private currentEditor: vscode.TextEditor | null = null;
    private currentRange: vscode.Range | null = null;

    /**
     * Start an inline edit session
     */
    async startInlineEdit(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('No active editor');
            return;
        }

        const selection = editor.selection;
        if (selection.isEmpty) {
            vscode.window.showInformationMessage('Please select code to edit');
            return;
        }

        this.currentEditor = editor;
        this.currentRange = selection;

        const selectedText = editor.document.getText(selection);
        const language = editor.document.languageId;

        // Show input box for edit instruction
        const instruction = await vscode.window.showInputBox({
            prompt: 'Describe the change you want to make',
            placeHolder: 'e.g., "add error handling", "convert to async/await", "add type annotations"',
            ignoreFocusOut: true,
        });

        if (!instruction) {
            return;
        }

        await this.performEdit(selectedText, language, instruction, editor, selection);
    }

    /**
     * Perform the inline edit
     */
    private async performEdit(
        originalCode: string,
        language: string,
        instruction: string,
        editor: vscode.TextEditor,
        range: vscode.Selection
    ): Promise<void> {
        const config = getConfig();
        const client = getOllamaClient(config.serverUrl);

        // Show progress
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Rubin: Generating edit...',
                cancellable: true,
            },
            async (progress, token) => {
                const abortController = new AbortController();
                token.onCancellationRequested(() => abortController.abort());

                const prompt = this.buildEditPrompt(originalCode, language, instruction);

                try {
                    progress.report({ increment: 30, message: 'Thinking...' });

                    const response = await client.generateChat(prompt, {
                        ...config,
                        maxTokens: 2048,
                        temperature: 0.2,
                    });

                    if (!response || token.isCancellationRequested) {
                        return;
                    }

                    progress.report({ increment: 50, message: 'Applying edit...' });

                    // Extract code from response
                    const newCode = this.extractCode(response, language);

                    if (!newCode) {
                        vscode.window.showErrorMessage('Could not extract code from response');
                        return;
                    }

                    // Show diff and ask for confirmation
                    const accepted = await this.showDiffAndConfirm(
                        editor.document,
                        range,
                        originalCode,
                        newCode
                    );

                    if (accepted) {
                        // Apply the edit
                        await editor.edit((editBuilder) => {
                            editBuilder.replace(range, newCode);
                        });
                        vscode.window.showInformationMessage('✅ Edit applied');
                        logger.info(`Inline edit applied: ${instruction}`);
                    }
                } catch (error) {
                    if (error instanceof Error && error.name === 'AbortError') {
                        return;
                    }
                    logger.error('Inline edit failed', error);
                    vscode.window.showErrorMessage(
                        `Edit failed: ${error instanceof Error ? error.message : 'Unknown error'}`
                    );
                }
            }
        );
    }

    /**
     * Build the prompt for code editing
     */
    private buildEditPrompt(code: string, language: string, instruction: string): string {
        return `You are a code editor. Your task is to modify code according to the user's instruction.

IMPORTANT RULES:
1. Return ONLY the modified code, nothing else
2. Do NOT include explanations before or after the code
3. Do NOT include markdown code fence markers (\`\`\`) 
4. Preserve the original indentation style
5. Make minimal changes to accomplish the task
6. Keep the code working and syntactically correct

INSTRUCTION: ${instruction}

ORIGINAL CODE (${language}):
${code}

MODIFIED CODE:`;
    }

    /**
     * Extract code from LLM response
     */
    private extractCode(response: string, language: string): string | null {
        let code = response.trim();

        // Remove markdown code blocks if present
        const codeBlockRegex = new RegExp(`\`\`\`(?:${language})?\\n?([\\s\\S]*?)\\n?\`\`\``, 'i');
        const match = code.match(codeBlockRegex);
        if (match) {
            code = match[1];
        }

        // Also try generic code block
        const genericMatch = code.match(/```\n?([\s\S]*?)\n?```/);
        if (genericMatch && !match) {
            code = genericMatch[1];
        }

        // Clean up
        code = code.trim();

        // Validate we got something
        if (!code || code.length < 1) {
            return null;
        }

        return code;
    }

    /**
     * Show a diff view and ask for confirmation
     */
    private async showDiffAndConfirm(
        document: vscode.TextDocument,
        range: vscode.Range,
        originalCode: string,
        newCode: string
    ): Promise<boolean> {
        // For now, use a simple confirmation dialog
        // In the future, could show a proper diff view
        
        const lines = newCode.split('\n').length;
        const chars = newCode.length;
        
        const result = await vscode.window.showInformationMessage(
            `Apply changes? (${lines} lines, ${chars} characters)`,
            { modal: false },
            'Apply',
            'Preview',
            'Cancel'
        );

        if (result === 'Preview') {
            // Show the new code in a preview
            const previewDoc = await vscode.workspace.openTextDocument({
                content: `// ORIGINAL:\n${originalCode}\n\n// PROPOSED CHANGE:\n${newCode}`,
                language: document.languageId,
            });
            await vscode.window.showTextDocument(previewDoc, {
                preview: true,
                viewColumn: vscode.ViewColumn.Beside,
            });

            // Ask again
            const confirmResult = await vscode.window.showInformationMessage(
                'Apply the proposed changes?',
                'Apply',
                'Cancel'
            );
            return confirmResult === 'Apply';
        }

        return result === 'Apply';
    }
}

// Singleton
let inlineChatInstance: InlineChatProvider | null = null;

export function getInlineChatProvider(): InlineChatProvider {
    if (!inlineChatInstance) {
        inlineChatInstance = new InlineChatProvider();
    }
    return inlineChatInstance;
}

/**
 * Register inline chat commands
 */
export function registerInlineChatCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('rubin.inlineEdit', () => {
            getInlineChatProvider().startInlineEdit();
        })
    );
}
