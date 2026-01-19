import * as vscode from 'vscode';
import * as cp from 'child_process';
import { getConfig } from './config';
import { getOllamaClient } from './ollamaClient';
import { logger } from './logger';

/**
 * Git integration for AI-powered features
 */
export class GitIntegration {
    private workspaceFolder: string | undefined;

    constructor() {
        this.workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    }

    /**
     * Generate a commit message for staged changes
     */
    async generateCommitMessage(): Promise<string | null> {
        if (!this.workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder open');
            return null;
        }

        try {
            // Get staged diff
            const diff = await this.getStagedDiff();
            
            if (!diff || diff.trim().length === 0) {
                vscode.window.showInformationMessage('No staged changes found. Stage some changes first.');
                return null;
            }

            // Get staged file list
            const stagedFiles = await this.getStagedFiles();

            const config = getConfig();
            const client = getOllamaClient(config.serverUrl);

            const prompt = this.buildCommitMessagePrompt(diff, stagedFiles);

            const response = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Generating commit message...',
                    cancellable: false,
                },
                async () => {
                    return await client.generateChat(prompt, {
                        ...config,
                        maxTokens: 500,
                        temperature: 0.3,
                    });
                }
            );

            if (response) {
                const message = this.cleanCommitMessage(response);
                return message;
            }

            return null;
        } catch (error) {
            logger.error('Failed to generate commit message', error);
            vscode.window.showErrorMessage(
                `Failed to generate commit message: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
            return null;
        }
    }

    /**
     * Get the diff of staged changes
     */
    private async getStagedDiff(): Promise<string> {
        return new Promise((resolve, reject) => {
            cp.exec(
                'git diff --staged',
                { cwd: this.workspaceFolder, maxBuffer: 1024 * 1024 },
                (error, stdout, stderr) => {
                    if (error) {
                        reject(new Error(stderr || error.message));
                    } else {
                        resolve(stdout);
                    }
                }
            );
        });
    }

    /**
     * Get list of staged files
     */
    private async getStagedFiles(): Promise<string[]> {
        return new Promise((resolve, reject) => {
            cp.exec(
                'git diff --staged --name-only',
                { cwd: this.workspaceFolder },
                (error, stdout, stderr) => {
                    if (error) {
                        reject(new Error(stderr || error.message));
                    } else {
                        resolve(stdout.trim().split('\n').filter(Boolean));
                    }
                }
            );
        });
    }

    /**
     * Get recent commit messages for style reference
     */
    private async getRecentCommits(): Promise<string[]> {
        return new Promise((resolve) => {
            cp.exec(
                'git log --oneline -10',
                { cwd: this.workspaceFolder },
                (error, stdout) => {
                    if (error) {
                        resolve([]);
                    } else {
                        resolve(stdout.trim().split('\n').filter(Boolean));
                    }
                }
            );
        });
    }

    /**
     * Build the prompt for commit message generation
     */
    private buildCommitMessagePrompt(diff: string, stagedFiles: string[]): string {
        // Truncate diff if too long
        const maxDiffLength = 4000;
        const truncatedDiff = diff.length > maxDiffLength 
            ? diff.substring(0, maxDiffLength) + '\n... (diff truncated)'
            : diff;

        return `Generate a git commit message for the following changes.

STAGED FILES:
${stagedFiles.join('\n')}

DIFF:
${truncatedDiff}

RULES:
1. Use Conventional Commits format: type(scope): description
2. Types: feat, fix, docs, style, refactor, perf, test, chore, build, ci
3. Keep the first line under 72 characters
4. Use imperative mood ("add" not "added")
5. Be specific but concise
6. Add a body only if needed to explain "why"

Return ONLY the commit message, nothing else.`;
    }

    /**
     * Clean up the generated commit message
     */
    private cleanCommitMessage(response: string): string {
        let message = response.trim();

        // Remove quotes if wrapped
        if ((message.startsWith('"') && message.endsWith('"')) ||
            (message.startsWith("'") && message.endsWith("'"))) {
            message = message.slice(1, -1);
        }

        // Remove markdown code blocks
        message = message.replace(/```\w*\n?/g, '').replace(/```/g, '');

        // Ensure proper line breaks
        message = message.replace(/\\n/g, '\n');

        return message.trim();
    }

    /**
     * Get current branch name
     */
    async getCurrentBranch(): Promise<string | null> {
        return new Promise((resolve) => {
            cp.exec(
                'git branch --show-current',
                { cwd: this.workspaceFolder },
                (error, stdout) => {
                    if (error) {
                        resolve(null);
                    } else {
                        resolve(stdout.trim());
                    }
                }
            );
        });
    }

    /**
     * Get uncommitted changes summary
     */
    async getChangeSummary(): Promise<string> {
        return new Promise((resolve) => {
            cp.exec(
                'git status --short',
                { cwd: this.workspaceFolder },
                (error, stdout) => {
                    if (error) {
                        resolve('Unable to get git status');
                    } else {
                        resolve(stdout.trim() || 'No changes');
                    }
                }
            );
        });
    }
}

// Singleton
let gitInstance: GitIntegration | null = null;

export function getGitIntegration(): GitIntegration {
    if (!gitInstance) {
        gitInstance = new GitIntegration();
    }
    return gitInstance;
}

/**
 * Register git-related commands
 */
export function registerGitCommands(context: vscode.ExtensionContext): void {
    // Generate commit message command
    context.subscriptions.push(
        vscode.commands.registerCommand('rubin.generateCommitMessage', async () => {
            const git = getGitIntegration();
            const message = await git.generateCommitMessage();

            if (message) {
                // Try to set it in the SCM input box
                const gitExtension = vscode.extensions.getExtension('vscode.git');
                if (gitExtension) {
                    const gitApi = gitExtension.exports.getAPI(1);
                    if (gitApi && gitApi.repositories.length > 0) {
                        gitApi.repositories[0].inputBox.value = message;
                        vscode.window.showInformationMessage('Commit message generated!');
                        return;
                    }
                }

                // Fallback: show in quick pick for copy
                const result = await vscode.window.showQuickPick(
                    [
                        { label: message, description: 'Click to copy' },
                        { label: '$(copy) Copy to clipboard', description: '' },
                    ],
                    { placeHolder: 'Generated commit message' }
                );

                if (result?.label === '$(copy) Copy to clipboard') {
                    await vscode.env.clipboard.writeText(message);
                    vscode.window.showInformationMessage('Copied to clipboard!');
                }
            }
        })
    );
}
