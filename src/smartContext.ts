/**
 * Smart Context Selection for Rubin
 * 
 * This module provides intelligent context gathering similar to GitHub Copilot.
 * It selects the most relevant context based on:
 * - Current file and cursor position
 * - Related files (imports, dependencies)
 * - Recently edited files
 * - Symbol definitions and references
 * - Project structure awareness
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface ContextItem {
    type: 'file' | 'selection' | 'symbol' | 'import' | 'related' | 'recent';
    path: string;
    content: string;
    language: string;
    relevance: number; // 0-1, higher is more relevant
    lines?: { start: number; end: number };
}

export interface SmartContext {
    items: ContextItem[];
    summary: string;
    totalTokensEstimate: number;
}

// Token estimation (rough approximation: 4 chars = 1 token)
function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

/**
 * Get smart context based on current editor state
 */
export async function getSmartContext(maxTokens: number = 4000): Promise<SmartContext> {
    const items: ContextItem[] = [];
    let totalTokens = 0;
    
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) {
        return { items: [], summary: 'No workspace open', totalTokensEstimate: 0 };
    }
    
    // 1. Current selection (highest priority)
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        const selection = editor.selection;
        if (!selection.isEmpty) {
            const text = editor.document.getText(selection);
            const tokens = estimateTokens(text);
            if (totalTokens + tokens < maxTokens) {
                items.push({
                    type: 'selection',
                    path: path.relative(workspaceFolder, editor.document.fileName),
                    content: text,
                    language: editor.document.languageId,
                    relevance: 1.0,
                    lines: {
                        start: selection.start.line + 1,
                        end: selection.end.line + 1,
                    },
                });
                totalTokens += tokens;
            }
        }
        
        // 2. Current file context around cursor
        const cursorLine = editor.selection.active.line;
        const startLine = Math.max(0, cursorLine - 30);
        const endLine = Math.min(editor.document.lineCount - 1, cursorLine + 30);
        const range = new vscode.Range(startLine, 0, endLine, editor.document.lineAt(endLine).text.length);
        const contextText = editor.document.getText(range);
        const contextTokens = estimateTokens(contextText);
        
        if (totalTokens + contextTokens < maxTokens) {
            items.push({
                type: 'file',
                path: path.relative(workspaceFolder, editor.document.fileName),
                content: contextText,
                language: editor.document.languageId,
                relevance: 0.9,
                lines: { start: startLine + 1, end: endLine + 1 },
            });
            totalTokens += contextTokens;
        }
        
        // 3. Find imports in current file
        const imports = await findImports(editor.document);
        for (const imp of imports.slice(0, 5)) { // Max 5 imported files
            if (totalTokens >= maxTokens * 0.8) { break; } // Reserve some space
            
            const importedContent = await getImportedFileContent(imp, workspaceFolder, editor.document.fileName);
            if (importedContent) {
                const tokens = estimateTokens(importedContent.content);
                if (totalTokens + tokens < maxTokens) {
                    items.push({
                        type: 'import',
                        path: importedContent.relativePath,
                        content: importedContent.content,
                        language: importedContent.language,
                        relevance: 0.7,
                    });
                    totalTokens += tokens;
                }
            }
        }
    }
    
    // 4. Recently edited files
    const recentFiles = getRecentlyEditedFiles(workspaceFolder);
    for (const file of recentFiles.slice(0, 3)) {
        if (totalTokens >= maxTokens * 0.9) { break; }
        
        // Skip if already included
        if (items.some(i => i.path === file.relativePath)) { continue; }
        
        try {
            const content = fs.readFileSync(file.fullPath, 'utf-8');
            // Only include first 50 lines of recent files
            const lines = content.split('\n').slice(0, 50).join('\n');
            const tokens = estimateTokens(lines);
            
            if (totalTokens + tokens < maxTokens) {
                items.push({
                    type: 'recent',
                    path: file.relativePath,
                    content: lines,
                    language: getLanguageId(file.relativePath),
                    relevance: 0.5,
                });
                totalTokens += tokens;
            }
        } catch {
            // Skip unreadable files
        }
    }
    
    // Sort by relevance
    items.sort((a, b) => b.relevance - a.relevance);
    
    // Generate summary
    const summary = generateContextSummary(items);
    
    return {
        items,
        summary,
        totalTokensEstimate: totalTokens,
    };
}

/**
 * Format smart context for inclusion in prompts
 */
export function formatSmartContext(context: SmartContext): string {
    const parts: string[] = [];
    
    for (const item of context.items) {
        let header = '';
        switch (item.type) {
            case 'selection':
                header = `### 📋 Selected Code (${item.path}${item.lines ? `, lines ${item.lines.start}-${item.lines.end}` : ''})`;
                break;
            case 'file':
                header = `### 📄 Current File (${item.path}${item.lines ? `, lines ${item.lines.start}-${item.lines.end}` : ''})`;
                break;
            case 'import':
                header = `### 📦 Imported (${item.path})`;
                break;
            case 'recent':
                header = `### ⏱️ Recent (${item.path})`;
                break;
            case 'related':
                header = `### 🔗 Related (${item.path})`;
                break;
            case 'symbol':
                header = `### 🔣 Symbol (${item.path})`;
                break;
        }
        
        parts.push(`${header}\n\`\`\`${item.language}\n${item.content}\n\`\`\``);
    }
    
    return parts.join('\n\n');
}

/**
 * Find import statements in a document
 */
async function findImports(document: vscode.TextDocument): Promise<string[]> {
    const text = document.getText();
    const imports: string[] = [];
    
    // TypeScript/JavaScript imports
    const tsImportRegex = /import\s+(?:(?:\{[^}]+\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"]([^'"]+)['"]/g;
    let match;
    while ((match = tsImportRegex.exec(text)) !== null) {
        imports.push(match[1]);
    }
    
    // Python imports
    const pyImportRegex = /(?:from\s+(\S+)\s+import|import\s+(\S+))/g;
    while ((match = pyImportRegex.exec(text)) !== null) {
        imports.push(match[1] || match[2]);
    }
    
    // Rust/Go imports
    const rustGoRegex = /use\s+([^;]+);|import\s+(?:\(\s*)?"([^"]+)"/g;
    while ((match = rustGoRegex.exec(text)) !== null) {
        imports.push(match[1] || match[2]);
    }
    
    // Filter local imports (not packages)
    return imports.filter(imp => imp.startsWith('.') || imp.startsWith('/'));
}

/**
 * Get content of an imported file
 */
async function getImportedFileContent(
    importPath: string,
    workspaceFolder: string,
    currentFile: string
): Promise<{ content: string; relativePath: string; language: string } | null> {
    // Resolve relative import
    let fullPath: string;
    
    if (importPath.startsWith('.')) {
        const currentDir = path.dirname(currentFile);
        fullPath = path.resolve(currentDir, importPath);
    } else {
        fullPath = path.join(workspaceFolder, importPath);
    }
    
    // Try with common extensions
    const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go'];
    for (const ext of extensions) {
        const tryPath = fullPath + ext;
        if (fs.existsSync(tryPath) && fs.statSync(tryPath).isFile()) {
            try {
                const content = fs.readFileSync(tryPath, 'utf-8');
                // Only include first 100 lines
                const lines = content.split('\n').slice(0, 100).join('\n');
                return {
                    content: lines,
                    relativePath: path.relative(workspaceFolder, tryPath),
                    language: getLanguageId(tryPath),
                };
            } catch {
                return null;
            }
        }
    }
    
    // Try index files
    for (const indexFile of ['index.ts', 'index.js', 'mod.rs', '__init__.py']) {
        const tryPath = path.join(fullPath, indexFile);
        if (fs.existsSync(tryPath)) {
            try {
                const content = fs.readFileSync(tryPath, 'utf-8');
                const lines = content.split('\n').slice(0, 100).join('\n');
                return {
                    content: lines,
                    relativePath: path.relative(workspaceFolder, tryPath),
                    language: getLanguageId(tryPath),
                };
            } catch {
                return null;
            }
        }
    }
    
    return null;
}

/**
 * Get recently edited files in the workspace
 */
function getRecentlyEditedFiles(workspaceFolder: string): Array<{ fullPath: string; relativePath: string }> {
    const files: Array<{ fullPath: string; relativePath: string }> = [];
    
    // Get from open tab groups
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (tab.input && typeof tab.input === 'object' && 'uri' in tab.input) {
                const uri = (tab.input as { uri: vscode.Uri }).uri;
                if (uri.scheme === 'file') {
                    files.push({
                        fullPath: uri.fsPath,
                        relativePath: path.relative(workspaceFolder, uri.fsPath),
                    });
                }
            }
        }
    }
    
    return files;
}

/**
 * Get VS Code language ID from file path
 */
function getLanguageId(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mapping: Record<string, string> = {
        '.ts': 'typescript',
        '.tsx': 'typescriptreact',
        '.js': 'javascript',
        '.jsx': 'javascriptreact',
        '.py': 'python',
        '.rs': 'rust',
        '.go': 'go',
        '.java': 'java',
        '.c': 'c',
        '.cpp': 'cpp',
        '.h': 'c',
        '.hpp': 'cpp',
        '.cs': 'csharp',
        '.rb': 'ruby',
        '.php': 'php',
        '.swift': 'swift',
        '.kt': 'kotlin',
        '.scala': 'scala',
        '.sh': 'shellscript',
        '.bash': 'shellscript',
        '.zsh': 'shellscript',
        '.md': 'markdown',
        '.json': 'json',
        '.yaml': 'yaml',
        '.yml': 'yaml',
        '.xml': 'xml',
        '.html': 'html',
        '.css': 'css',
        '.scss': 'scss',
        '.less': 'less',
        '.sql': 'sql',
        '.graphql': 'graphql',
        '.vue': 'vue',
        '.svelte': 'svelte',
    };
    return mapping[ext] || 'plaintext';
}

/**
 * Generate a summary of the gathered context
 */
function generateContextSummary(items: ContextItem[]): string {
    const types = new Map<string, number>();
    let totalLines = 0;
    
    for (const item of items) {
        types.set(item.type, (types.get(item.type) || 0) + 1);
        totalLines += item.content.split('\n').length;
    }
    
    const parts: string[] = [];
    if (types.get('selection')) { parts.push(`${types.get('selection')} selection(s)`); }
    if (types.get('file')) { parts.push(`${types.get('file')} file(s)`); }
    if (types.get('import')) { parts.push(`${types.get('import')} import(s)`); }
    if (types.get('recent')) { parts.push(`${types.get('recent')} recent file(s)`); }
    
    return `Context: ${parts.join(', ')} (~${totalLines} lines)`;
}

/**
 * Find symbols related to the current cursor position
 */
export async function findRelatedSymbols(
    document: vscode.TextDocument,
    position: vscode.Position
): Promise<string[]> {
    const symbols: string[] = [];
    
    try {
        // Get word at position
        const wordRange = document.getWordRangeAtPosition(position);
        if (wordRange) {
            // Find definition
            const definitions = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeDefinitionProvider',
                document.uri,
                position
            );
            
            if (definitions && definitions.length > 0) {
                for (const def of definitions) {
                    const defDoc = await vscode.workspace.openTextDocument(def.uri);
                    // Get context around definition (10 lines before and after)
                    const startLine = Math.max(0, def.range.start.line - 10);
                    const endLine = Math.min(defDoc.lineCount - 1, def.range.end.line + 10);
                    const range = new vscode.Range(startLine, 0, endLine, defDoc.lineAt(endLine).text.length);
                    symbols.push(defDoc.getText(range));
                }
            }
        }
    } catch {
        // Ignore errors - symbols are optional context
    }
    
    return symbols;
}
