import * as vscode from 'vscode';

/**
 * Provides code actions like "Explain", "Fix", "Generate Tests", etc.
 * Similar to GitHub Copilot's inline code actions.
 */
export class RubinCodeActionProvider implements vscode.CodeActionProvider {
    public static readonly providedCodeActionKinds = [
        vscode.CodeActionKind.QuickFix,
        vscode.CodeActionKind.Refactor,
    ];

    provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
        _token: vscode.CancellationToken
    ): vscode.CodeAction[] {
        const actions: vscode.CodeAction[] = [];

        // Only show actions if there's a selection or diagnostics
        const hasSelection = !range.isEmpty;
        const hasDiagnostics = context.diagnostics.length > 0;

        if (hasSelection) {
            // Add actions for selected code
            actions.push(
                this.createAction('💡 Rubin: Explain Code', 'rubin.explainCode', document, range),
                this.createAction('🔧 Rubin: Fix Code', 'rubin.fixCode', document, range),
                this.createAction('🧪 Rubin: Generate Tests', 'rubin.generateTests', document, range),
                this.createAction('📝 Rubin: Add Documentation', 'rubin.addDocs', document, range),
                this.createAction('⚡ Rubin: Optimize', 'rubin.optimizeCode', document, range),
                this.createAction('🔄 Rubin: Refactor', 'rubin.refactorCode', document, range)
            );
        }

        if (hasDiagnostics) {
            // Add fix actions for diagnostics
            const diagnostic = context.diagnostics[0];
            const fixAction = this.createAction(
                `🔧 Rubin: Fix "${diagnostic.message.substring(0, 50)}..."`,
                'rubin.fixDiagnostic',
                document,
                range,
                { diagnostic }
            );
            fixAction.isPreferred = true;
            actions.push(fixAction);
        }

        return actions;
    }

    private createAction(
        title: string,
        command: string,
        document: vscode.TextDocument,
        range: vscode.Range,
        extraArgs?: Record<string, unknown>
    ): vscode.CodeAction {
        const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
        action.command = {
            command,
            title,
            arguments: [
                {
                    document: document.uri.toString(),
                    range: {
                        start: { line: range.start.line, character: range.start.character },
                        end: { line: range.end.line, character: range.end.character },
                    },
                    text: document.getText(range),
                    language: document.languageId,
                    fileName: document.fileName,
                    ...extraArgs,
                },
            ],
        };
        return action;
    }
}

/**
 * Arguments passed to code action commands
 */
export interface CodeActionArgs {
    document: string;
    range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
    };
    text: string;
    language: string;
    fileName: string;
    diagnostic?: vscode.Diagnostic;
}

/**
 * Register all code action commands
 */
export function registerCodeActionCommands(
    context: vscode.ExtensionContext,
    sendToChat: (message: string) => void
): void {
    // Explain Code
    context.subscriptions.push(
        vscode.commands.registerCommand('rubin.explainCode', (args: CodeActionArgs) => {
            const prompt = `/explain\n\n\`\`\`${args.language}\n${args.text}\n\`\`\``;
            sendToChat(prompt);
            vscode.commands.executeCommand('rubin.unifiedView.focus');
        })
    );

    // Fix Code
    context.subscriptions.push(
        vscode.commands.registerCommand('rubin.fixCode', (args: CodeActionArgs) => {
            const prompt = `/fix\n\n\`\`\`${args.language}\n${args.text}\n\`\`\``;
            sendToChat(prompt);
            vscode.commands.executeCommand('rubin.unifiedView.focus');
        })
    );

    // Generate Tests
    context.subscriptions.push(
        vscode.commands.registerCommand('rubin.generateTests', (args: CodeActionArgs) => {
            const prompt = `/tests\n\n\`\`\`${args.language}\n${args.text}\n\`\`\``;
            sendToChat(prompt);
            vscode.commands.executeCommand('rubin.unifiedView.focus');
        })
    );

    // Add Documentation
    context.subscriptions.push(
        vscode.commands.registerCommand('rubin.addDocs', (args: CodeActionArgs) => {
            const prompt = `/doc\n\n\`\`\`${args.language}\n${args.text}\n\`\`\``;
            sendToChat(prompt);
            vscode.commands.executeCommand('rubin.unifiedView.focus');
        })
    );

    // Optimize Code
    context.subscriptions.push(
        vscode.commands.registerCommand('rubin.optimizeCode', (args: CodeActionArgs) => {
            const prompt = `/optimize\n\n\`\`\`${args.language}\n${args.text}\n\`\`\``;
            sendToChat(prompt);
            vscode.commands.executeCommand('rubin.unifiedView.focus');
        })
    );

    // Refactor Code
    context.subscriptions.push(
        vscode.commands.registerCommand('rubin.refactorCode', (args: CodeActionArgs) => {
            const prompt = `/refactor\n\n\`\`\`${args.language}\n${args.text}\n\`\`\``;
            sendToChat(prompt);
            vscode.commands.executeCommand('rubin.unifiedView.focus');
        })
    );

    // Fix Diagnostic
    context.subscriptions.push(
        vscode.commands.registerCommand('rubin.fixDiagnostic', (args: CodeActionArgs) => {
            const diagnostic = args.diagnostic;
            const errorMessage = diagnostic ? diagnostic.message : 'unknown error';
            const prompt = `/fix ${errorMessage}\n\n\`\`\`${args.language}\n${args.text}\n\`\`\``;
            sendToChat(prompt);
            vscode.commands.executeCommand('rubin.unifiedView.focus');
        })
    );
}

/**
 * Register the code action provider for all languages
 */
export function registerCodeActionProvider(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            { pattern: '**/*' },
            new RubinCodeActionProvider(),
            {
                providedCodeActionKinds: RubinCodeActionProvider.providedCodeActionKinds,
            }
        )
    );
}
