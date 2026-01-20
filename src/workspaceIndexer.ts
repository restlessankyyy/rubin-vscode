import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from './logger';

/**
 * Indexed file information
 */
export interface IndexedFile {
    relativePath: string;
    absolutePath: string;
    language: string;
    size: number;
    symbols?: string[];
}

/**
 * Search result from workspace
 */
export interface WorkspaceSearchResult {
    file: IndexedFile;
    matches: Array<{
        line: number;
        content: string;
        preview: string;
    }>;
    score: number;
}

/**
 * Manages workspace indexing and search
 */
export class WorkspaceIndexer {
    private fileIndex: Map<string, IndexedFile> = new Map();
    private isIndexing: boolean = false;
    private lastIndexTime: number = 0;
    private readonly INDEX_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

    /**
     * Get or build the workspace index
     */
    async getIndex(): Promise<Map<string, IndexedFile>> {
        const now = Date.now();
        
        // Re-index if expired or empty
        if (this.fileIndex.size === 0 || (now - this.lastIndexTime) > this.INDEX_EXPIRY_MS) {
            await this.buildIndex();
        }

        return this.fileIndex;
    }

    /**
     * Build the workspace file index
     */
    async buildIndex(): Promise<void> {
        if (this.isIndexing) {
            return;
        }

        this.isIndexing = true;
        logger.info('Building workspace index...');

        try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                return;
            }

            // Find all relevant files
            const files = await vscode.workspace.findFiles(
                '**/*.{ts,tsx,js,jsx,py,java,go,rs,c,cpp,h,hpp,cs,rb,php,swift,kt,scala,vue,svelte,html,css,scss,json,yaml,yml,md,sql}',
                '**/node_modules/**',
                1000 // Limit for performance
            );

            this.fileIndex.clear();

            for (const file of files) {
                try {
                    const stat = await vscode.workspace.fs.stat(file);
                    const relativePath = vscode.workspace.asRelativePath(file);
                    
                    const indexed: IndexedFile = {
                        relativePath,
                        absolutePath: file.fsPath,
                        language: this.getLanguageFromPath(file.fsPath),
                        size: stat.size,
                    };

                    this.fileIndex.set(relativePath, indexed);
                } catch {
                    // Skip files that can't be accessed
                }
            }

            this.lastIndexTime = Date.now();
            logger.info(`Indexed ${this.fileIndex.size} files`);
        } finally {
            this.isIndexing = false;
        }
    }

    /**
     * Search the workspace for files matching a query
     */
    async searchFiles(query: string, maxResults: number = 10): Promise<IndexedFile[]> {
        const index = await this.getIndex();
        const results: Array<{ file: IndexedFile; score: number }> = [];
        const queryLower = query.toLowerCase();
        const queryParts = queryLower.split(/\s+/);

        for (const [relativePath, file] of index) {
            const pathLower = relativePath.toLowerCase();
            let score = 0;

            // Exact filename match
            const fileName = path.basename(pathLower);
            if (fileName.includes(queryLower)) {
                score += 10;
            }

            // Path contains query
            if (pathLower.includes(queryLower)) {
                score += 5;
            }

            // All query parts found
            const allPartsFound = queryParts.every(part => pathLower.includes(part));
            if (allPartsFound) {
                score += 3 * queryParts.length;
            }

            if (score > 0) {
                results.push({ file, score });
            }
        }

        // Sort by score and return top results
        return results
            .sort((a, b) => b.score - a.score)
            .slice(0, maxResults)
            .map(r => r.file);
    }

    /**
     * Search for text content within files
     */
    async searchContent(query: string, maxResults: number = 20): Promise<WorkspaceSearchResult[]> {
        const results: WorkspaceSearchResult[] = [];
        const queryLower = query.toLowerCase();

        // Manual search in indexed files (for smaller workspaces)
        const index = await this.getIndex();
        
        for (const [, file] of index) {
            if (results.length >= maxResults) {
                break;
            }

            // Skip large files
            if (file.size > 100000) {
                continue;
            }

            try {
                const content = fs.readFileSync(file.absolutePath, 'utf-8');
                const lines = content.split('\n');
                const matches: WorkspaceSearchResult['matches'] = [];

                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].toLowerCase().includes(queryLower)) {
                        matches.push({
                            line: i + 1,
                            content: lines[i],
                            preview: lines[i].trim().substring(0, 100),
                        });

                        if (matches.length >= 3) {
                            break; // Limit matches per file
                        }
                    }
                }

                if (matches.length > 0) {
                    results.push({
                        file,
                        matches,
                        score: matches.length,
                    });
                }
            } catch {
                // Skip files that can't be read
            }
        }

        return results.sort((a, b) => b.score - a.score);
    }

    /**
     * Get workspace structure summary
     */
    async getWorkspaceSummary(): Promise<string> {
        const index = await this.getIndex();
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        
        if (!workspaceFolder) {
            return 'No workspace folder open.';
        }

        // Group files by directory
        const directories = new Map<string, string[]>();
        
        for (const [relativePath] of index) {
            const dir = path.dirname(relativePath);
            const existing = directories.get(dir);
            if (existing) {
                existing.push(path.basename(relativePath));
            } else {
                directories.set(dir, [path.basename(relativePath)]);
            }
        }

        // Build tree-like structure
        let summary = `Workspace: ${workspaceFolder.name}\n`;
        summary += `Total files: ${index.size}\n\n`;
        summary += `Structure:\n`;

        const sortedDirs = Array.from(directories.keys()).sort();
        for (const dir of sortedDirs.slice(0, 20)) { // Limit for readability
            const files = directories.get(dir) || [];
            summary += `📁 ${dir}/\n`;
            for (const file of files.slice(0, 5)) {
                summary += `   📄 ${file}\n`;
            }
            if (files.length > 5) {
                summary += `   ... and ${files.length - 5} more\n`;
            }
        }

        if (sortedDirs.length > 20) {
            summary += `\n... and ${sortedDirs.length - 20} more directories`;
        }

        return summary;
    }

    /**
     * Find files related to a given file (imports, similar names)
     */
    async findRelatedFiles(filePath: string): Promise<IndexedFile[]> {
        const index = await this.getIndex();
        const fileName = path.basename(filePath, path.extname(filePath));
        const related: IndexedFile[] = [];

        for (const [, file] of index) {
            if (file.absolutePath === filePath) {
                continue;
            }

            const otherName = path.basename(file.absolutePath, path.extname(file.absolutePath));
            
            // Same base name (e.g., component.ts and component.test.ts)
            if (otherName.includes(fileName) || fileName.includes(otherName)) {
                related.push(file);
            }
        }

        return related.slice(0, 10);
    }

    /**
     * Get language from file path
     */
    private getLanguageFromPath(filePath: string): string {
        const ext = path.extname(filePath).toLowerCase();
        const languageMap: Record<string, string> = {
            '.ts': 'typescript',
            '.tsx': 'typescriptreact',
            '.js': 'javascript',
            '.jsx': 'javascriptreact',
            '.py': 'python',
            '.java': 'java',
            '.go': 'go',
            '.rs': 'rust',
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
            '.vue': 'vue',
            '.svelte': 'svelte',
            '.html': 'html',
            '.css': 'css',
            '.scss': 'scss',
            '.json': 'json',
            '.yaml': 'yaml',
            '.yml': 'yaml',
            '.md': 'markdown',
            '.sql': 'sql',
        };

        return languageMap[ext] || 'plaintext';
    }
}

// Singleton instance
let indexerInstance: WorkspaceIndexer | null = null;

export function getWorkspaceIndexer(): WorkspaceIndexer {
    if (!indexerInstance) {
        indexerInstance = new WorkspaceIndexer();
    }
    return indexerInstance;
}
