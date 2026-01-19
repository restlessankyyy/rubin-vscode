import * as vscode from 'vscode';
import * as path from 'path';

export interface ContextItem {
    type: 'file' | 'selection' | 'diagnostics' | 'structure';
    title: string;
    content: string;
    language?: string;
    priority: number; // Higher is more important
}

export class ContextManager {

    async getContext(): Promise<ContextItem[]> {
        const items: ContextItem[] = [];

        // 1. Active Editor (Highest Priority)
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
            const fileName = path.basename(activeEditor.document.fileName);
            const content = activeEditor.document.getText();
            const selection = activeEditor.selection;

            // If text is selected, prioritize that
            if (!selection.isEmpty) {
                items.push({
                    type: 'selection',
                    title: `Selected Code (${fileName})`,
                    content: activeEditor.document.getText(selection),
                    language: activeEditor.document.languageId,
                    priority: 10
                });
            }

            // Always include the active file
            items.push({
                type: 'file',
                title: `Active File: ${fileName}`,
                content: content,
                language: activeEditor.document.languageId,
                priority: 9
            });
        }

        // 2. Diagnostics (Errors/Warnings)
        const diagnostics = vscode.languages.getDiagnostics();
        const problems: string[] = [];

        for (const [uri, diags] of diagnostics) {
            if (diags.length === 0) {
                continue;
            }
            // Only care about file-schema URIs
            if (uri.scheme !== 'file') {
                continue;
            }

            const relativePath = vscode.workspace.asRelativePath(uri);
            const severityCount = { error: 0, warning: 0 };

            const fileProblems = diags.map(d => {
                const line = d.range.start.line + 1;
                const severity = d.severity === vscode.DiagnosticSeverity.Error ? 'Error' : 'Warning';
                if (severity === 'Error') {
                    severityCount.error++;
                }
                if (severity === 'Warning') {
                    severityCount.warning++;
                }
                return `  - [Line ${line}] ${severity}: ${d.message}`;
            });

            if (fileProblems.length > 0) {
                problems.push(`File: ${relativePath}\n${fileProblems.join('\n')}`);
            }
        }

        if (problems.length > 0) {
            items.push({
                type: 'diagnostics',
                title: 'Workspace Problems',
                content: problems.join('\n\n'),
                priority: 8
            });
        }

        // 3. Other Open Tabs (Lower Priority)
        // Note: VS Code API doesn't give a direct list of "tabs", but we can look
        // at visibleTextEditors or just rely on the user to 'open' relevant files.
        // For now, we'll iterate visible editors that aren't the active one.
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor === activeEditor) {
                continue;
            }

            const fileName = path.basename(editor.document.fileName);
            items.push({
                type: 'file',
                title: `Open File: ${fileName}`,
                content: editor.document.getText(),
                language: editor.document.languageId,
                priority: 5
            });
        }

        return items.sort((a, b) => b.priority - a.priority);
    }

    formatContextForPrompt(items: ContextItem[]): string {
        if (items.length === 0) {
            return '';
        }

        let contextString = '\n\n## Context Information\n';

        for (const item of items) {
            contextString += `\n### ${item.title}\n`;
            if (item.language) {
                contextString += `\`\`\`${item.language}\n${item.content}\n\`\`\``;
            } else {
                contextString += item.content;
            }
        }

        return contextString;
    }
}
