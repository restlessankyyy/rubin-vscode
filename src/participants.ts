/**
 * Participants System - @mentions for Rubin
 * 
 * This module provides GitHub Copilot-like @mention functionality:
 * - @workspace - Include workspace context and file structure
 * - @file - Reference specific files by path
 * - @terminal - Include terminal history and output
 * - @git - Include git context (status, diff, branch)
 * - @selection - Include current editor selection
 * - @problems - Include diagnostics/problems from the workspace
 * - @symbols - Include symbols from specific files
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import { getWorkspaceIndexer } from './workspaceIndexer';

export interface Participant {
    name: string;
    description: string;
    icon: string;
    handler: (args: string) => Promise<string>;
}

export interface MentionMatch {
    participant: string;
    args: string;
    fullMatch: string;
    startIndex: number;
    endIndex: number;
}

export interface ProcessedMessage {
    cleanMessage: string;
    contextBlocks: string[];
    mentions: MentionMatch[];
}

// Participant definitions
const PARTICIPANTS: Participant[] = [
    {
        name: 'workspace',
        description: 'Include workspace structure and file overview',
        icon: '📁',
        handler: handleWorkspaceMention,
    },
    {
        name: 'file',
        description: 'Include content of a specific file',
        icon: '📄',
        handler: handleFileMention,
    },
    {
        name: 'terminal',
        description: 'Include recent terminal output',
        icon: '💻',
        handler: handleTerminalMention,
    },
    {
        name: 'git',
        description: 'Include git status, diff, and branch info',
        icon: '🔀',
        handler: handleGitMention,
    },
    {
        name: 'selection',
        description: 'Include current editor selection',
        icon: '✂️',
        handler: handleSelectionMention,
    },
    {
        name: 'problems',
        description: 'Include workspace diagnostics and problems',
        icon: '⚠️',
        handler: handleProblemsMention,
    },
    {
        name: 'symbols',
        description: 'Include symbols from a file or workspace',
        icon: '🔣',
        handler: handleSymbolsMention,
    },
    {
        name: 'docs',
        description: 'Search for documentation patterns',
        icon: '📚',
        handler: handleDocsMention,
    },
];

/**
 * Parse message for @mentions and extract all participant references
 */
export function parseMentions(message: string): MentionMatch[] {
    const mentions: MentionMatch[] = [];
    
    // Match @participant or @participant:args or @participant(args) or @file:path/to/file
    const mentionRegex = /@(\w+)(?::([^\s]+)|(?:\(([^)]+)\)))?/g;
    
    let match;
    while ((match = mentionRegex.exec(message)) !== null) {
        const participant = match[1].toLowerCase();
        const args = match[2] || match[3] || '';
        
        mentions.push({
            participant,
            args,
            fullMatch: match[0],
            startIndex: match.index,
            endIndex: match.index + match[0].length,
        });
    }
    
    return mentions;
}

/**
 * Process a message by resolving all @mentions and gathering context
 */
export async function processMessage(message: string): Promise<ProcessedMessage> {
    const mentions = parseMentions(message);
    const contextBlocks: string[] = [];
    let cleanMessage = message;
    
    // Process mentions in reverse order to maintain string indices
    for (let i = mentions.length - 1; i >= 0; i--) {
        const mention = mentions[i];
        const participant = PARTICIPANTS.find(p => p.name === mention.participant);
        
        if (participant) {
            try {
                const context = await participant.handler(mention.args);
                if (context) {
                    contextBlocks.unshift(`### ${participant.icon} @${mention.participant} Context\n${context}`);
                }
            } catch (error) {
                contextBlocks.unshift(`### ⚠️ Error resolving @${mention.participant}\n${error}`);
            }
        }
        
        // Remove the mention from the clean message (keep a placeholder)
        cleanMessage = cleanMessage.substring(0, mention.startIndex) + 
                       cleanMessage.substring(mention.endIndex);
    }
    
    return {
        cleanMessage: cleanMessage.replace(/\s+/g, ' ').trim(),
        contextBlocks,
        mentions,
    };
}

/**
 * Get all available participants for autocomplete
 */
export function getParticipants(): Participant[] {
    return PARTICIPANTS;
}

/**
 * Get autocomplete suggestions based on partial input
 */
export function getAutocompleteSuggestions(partial: string): Array<{label: string; description: string}> {
    const suggestions: Array<{label: string; description: string}> = [];
    
    // If it starts with @, suggest participants
    if (partial.startsWith('@')) {
        const query = partial.substring(1).toLowerCase();
        for (const p of PARTICIPANTS) {
            if (p.name.startsWith(query)) {
                suggestions.push({
                    label: `@${p.name}`,
                    description: p.description,
                });
            }
        }
    }
    
    // If it's @file:, suggest file paths
    if (partial.toLowerCase().startsWith('@file:')) {
        const pathQuery = partial.substring(6);
        const files = getRecentFiles();
        for (const file of files) {
            if (file.toLowerCase().includes(pathQuery.toLowerCase())) {
                suggestions.push({
                    label: `@file:${file}`,
                    description: 'File',
                });
            }
        }
    }
    
    return suggestions.slice(0, 10);
}

// ============ Participant Handlers ============

async function handleWorkspaceMention(_args: string): Promise<string> {
    const indexer = getWorkspaceIndexer();
    const summary = await indexer.getWorkspaceSummary();
    
    // Add some additional context
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    let context = `**Workspace:** ${workspaceFolder?.name || 'Unknown'}\n\n`;
    context += summary;
    
    return context;
}

async function handleFileMention(args: string): Promise<string> {
    if (!args) {
        return 'Please specify a file path: @file:path/to/file.ts';
    }
    
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) {
        return 'No workspace folder open';
    }
    
    // Try to find the file
    const filePath = args.trim();
    let fullPath = path.join(workspaceFolder, filePath);
    
    // If not found, try to find it with a glob pattern
    if (!fs.existsSync(fullPath)) {
        const files = await vscode.workspace.findFiles(`**/${filePath}`, '**/node_modules/**', 1);
        if (files.length > 0) {
            fullPath = files[0].fsPath;
        } else {
            return `File not found: ${filePath}`;
        }
    }
    
    try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const relativePath = path.relative(workspaceFolder, fullPath);
        const ext = path.extname(fullPath).substring(1);
        
        // Limit content size
        const lines = content.split('\n');
        const truncated = lines.length > 200;
        const displayContent = truncated 
            ? lines.slice(0, 200).join('\n') + '\n\n... (truncated, showing first 200 lines)'
            : content;
        
        return `**File:** ${relativePath}\n\`\`\`${ext}\n${displayContent}\n\`\`\``;
    } catch (error) {
        return `Error reading file: ${error}`;
    }
}

async function handleTerminalMention(_args: string): Promise<string> {
    // Get terminal output from active terminal
    const terminals = vscode.window.terminals;
    
    if (terminals.length === 0) {
        return 'No active terminals found.';
    }
    
    let context = `**Active Terminals:** ${terminals.length}\n\n`;
    
    for (const terminal of terminals) {
        const pid = await terminal.processId;
        context += `- **${terminal.name}** (${pid ? 'running' : 'idle'})\n`;
    }
    
    // Note: VS Code doesn't expose terminal content directly
    // We can only provide metadata about terminals
    context += '\n*Note: Terminal output is not directly accessible. Use the Agent mode with `runCommand` tool for command execution and output capture.*';
    
    return context;
}

async function handleGitMention(args: string): Promise<string> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) {
        return 'No workspace folder open';
    }
    
    const context: string[] = [];
    
    // Get branch
    try {
        const branch = await execPromise('git branch --show-current', workspaceFolder);
        context.push(`**Branch:** ${branch.trim()}`);
    } catch {
        context.push('**Branch:** Unable to determine (not a git repo?)');
    }
    
    // Get status
    try {
        const status = await execPromise('git status --porcelain', workspaceFolder);
        if (status.trim()) {
            context.push('**Changes:**\n```\n' + status.trim() + '\n```');
        } else {
            context.push('**Changes:** Working tree clean');
        }
    } catch (e) {
        context.push(`**Status:** Error getting status: ${e}`);
    }
    
    // Get recent commits
    try {
        const log = await execPromise('git log --oneline -5', workspaceFolder);
        context.push('**Recent Commits:**\n```\n' + log.trim() + '\n```');
    } catch {
        // Ignore
    }
    
    // If specific file requested, show its diff
    if (args) {
        try {
            const diff = await execPromise(`git diff -- "${args}"`, workspaceFolder);
            if (diff.trim()) {
                const lines = diff.split('\n');
                const truncated = lines.length > 50 ? lines.slice(0, 50).join('\n') + '\n...(truncated)' : diff;
                context.push(`**Diff for ${args}:**\n\`\`\`diff\n${truncated}\n\`\`\``);
            }
        } catch {
            // Ignore
        }
    }
    
    return context.join('\n\n');
}

async function handleSelectionMention(_args: string): Promise<string> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return 'No active editor';
    }
    
    const selection = editor.selection;
    if (selection.isEmpty) {
        return 'No text selected. Select some code first.';
    }
    
    const text = editor.document.getText(selection);
    const fileName = path.basename(editor.document.fileName);
    const language = editor.document.languageId;
    const startLine = selection.start.line + 1;
    const endLine = selection.end.line + 1;
    
    return `**Selection from ${fileName}** (lines ${startLine}-${endLine}):\n\`\`\`${language}\n${text}\n\`\`\``;
}

async function handleProblemsMention(_args: string): Promise<string> {
    const diagnostics = vscode.languages.getDiagnostics();
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    
    const problems: string[] = [];
    let errorCount = 0;
    let warningCount = 0;
    
    for (const [uri, diags] of diagnostics) {
        if (diags.length === 0) { continue; }
        
        const relativePath = workspaceFolder 
            ? path.relative(workspaceFolder, uri.fsPath)
            : uri.fsPath;
        
        for (const diag of diags) {
            const severity = diag.severity === vscode.DiagnosticSeverity.Error ? '🔴' : 
                            diag.severity === vscode.DiagnosticSeverity.Warning ? '🟡' : '🔵';
            
            if (diag.severity === vscode.DiagnosticSeverity.Error) { errorCount++; }
            if (diag.severity === vscode.DiagnosticSeverity.Warning) { warningCount++; }
            
            problems.push(`${severity} **${relativePath}:${diag.range.start.line + 1}** - ${diag.message}`);
            
            if (problems.length >= 20) { break; }
        }
        
        if (problems.length >= 20) { break; }
    }
    
    if (problems.length === 0) {
        return '✅ No problems found in the workspace!';
    }
    
    let summary = `**Problems:** ${errorCount} errors, ${warningCount} warnings\n\n`;
    summary += problems.join('\n');
    
    if (problems.length >= 20) {
        summary += '\n\n*(showing first 20 problems)*';
    }
    
    return summary;
}

async function handleSymbolsMention(args: string): Promise<string> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) {
        return 'No workspace folder open';
    }
    
    // If no file specified, use current file
    let targetFile = args.trim();
    if (!targetFile) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return 'No file specified and no active editor. Use @symbols:path/to/file.ts';
        }
        targetFile = path.relative(workspaceFolder, editor.document.uri.fsPath);
    }
    
    let fullPath = path.join(workspaceFolder, targetFile);
    if (!fs.existsSync(fullPath)) {
        const files = await vscode.workspace.findFiles(`**/${targetFile}`, '**/node_modules/**', 1);
        if (files.length > 0) {
            fullPath = files[0].fsPath;
        } else {
            return `File not found: ${targetFile}`;
        }
    }
    
    const uri = vscode.Uri.file(fullPath);
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        uri
    );
    
    if (!symbols || symbols.length === 0) {
        return `No symbols found in ${targetFile}`;
    }
    
    const formatSymbols = (syms: vscode.DocumentSymbol[], indent: string = ''): string[] => {
        const lines: string[] = [];
        for (const s of syms) {
            const kind = vscode.SymbolKind[s.kind];
            const icon = getSymbolIcon(s.kind);
            lines.push(`${indent}${icon} **${s.name}** (${kind}, line ${s.range.start.line + 1})`);
            if (s.children && s.children.length > 0) {
                lines.push(...formatSymbols(s.children, indent + '  '));
            }
        }
        return lines;
    };
    
    const relativePath = path.relative(workspaceFolder, fullPath);
    return `**Symbols in ${relativePath}:**\n\n${formatSymbols(symbols).join('\n')}`;
}

async function handleDocsMention(args: string): Promise<string> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) {
        return 'No workspace folder open';
    }
    
    // Search for documentation files
    const docPatterns = [
        '**/README.md',
        '**/CONTRIBUTING.md',
        '**/docs/**/*.md',
        '**/*.md',
    ];
    
    const results: string[] = [];
    
    for (const pattern of docPatterns) {
        const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 5);
        for (const file of files) {
            const relativePath = path.relative(workspaceFolder, file.fsPath);
            results.push(`- ${relativePath}`);
        }
    }
    
    if (results.length === 0) {
        return 'No documentation files found.';
    }
    
    let context = '**Documentation Files Found:**\n' + [...new Set(results)].slice(0, 15).join('\n');
    
    // If a specific doc was requested, try to include its content
    if (args) {
        const files = await vscode.workspace.findFiles(`**/*${args}*`, '**/node_modules/**', 1);
        if (files.length > 0) {
            try {
                const content = fs.readFileSync(files[0].fsPath, 'utf-8');
                const lines = content.split('\n');
                const preview = lines.slice(0, 50).join('\n');
                context += `\n\n**Preview of ${path.basename(files[0].fsPath)}:**\n${preview}`;
            } catch {
                // Ignore
            }
        }
    }
    
    return context;
}

// ============ Utility Functions ============

function execPromise(command: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        cp.exec(command, { cwd, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                reject(stderr || error.message);
            } else {
                resolve(stdout);
            }
        });
    });
}

function getRecentFiles(): string[] {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) { return []; }
    
    // Get recently opened files from tab groups
    const files: string[] = [];
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (tab.input && typeof tab.input === 'object' && 'uri' in tab.input) {
                const uri = (tab.input as { uri: vscode.Uri }).uri;
                files.push(path.relative(workspaceFolder, uri.fsPath));
            }
        }
    }
    
    return [...new Set(files)].slice(0, 20);
}

function getSymbolIcon(kind: vscode.SymbolKind): string {
    const icons: Record<number, string> = {
        [vscode.SymbolKind.File]: '📄',
        [vscode.SymbolKind.Module]: '📦',
        [vscode.SymbolKind.Namespace]: '🏷️',
        [vscode.SymbolKind.Package]: '📦',
        [vscode.SymbolKind.Class]: '🔷',
        [vscode.SymbolKind.Method]: '🔶',
        [vscode.SymbolKind.Property]: '🔸',
        [vscode.SymbolKind.Field]: '🔸',
        [vscode.SymbolKind.Constructor]: '🔨',
        [vscode.SymbolKind.Enum]: '📋',
        [vscode.SymbolKind.Interface]: '🔲',
        [vscode.SymbolKind.Function]: '⚡',
        [vscode.SymbolKind.Variable]: '📌',
        [vscode.SymbolKind.Constant]: '🔒',
        [vscode.SymbolKind.String]: '📝',
        [vscode.SymbolKind.Number]: '🔢',
        [vscode.SymbolKind.Boolean]: '✅',
        [vscode.SymbolKind.Array]: '📚',
        [vscode.SymbolKind.Object]: '📦',
        [vscode.SymbolKind.Key]: '🔑',
        [vscode.SymbolKind.Null]: '⭕',
        [vscode.SymbolKind.EnumMember]: '📋',
        [vscode.SymbolKind.Struct]: '🏗️',
        [vscode.SymbolKind.Event]: '⚡',
        [vscode.SymbolKind.Operator]: '➕',
        [vscode.SymbolKind.TypeParameter]: '📐',
    };
    return icons[kind] || '•';
}
