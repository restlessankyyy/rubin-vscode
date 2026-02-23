import * as https from 'https';
import * as http from 'http';
import { LocalCopilotConfig } from './config';
import { StreamCallbacks } from './ollamaClient';

// Models available via Ollama's Claude-compatible integration
// See: https://docs.ollama.com/integrations/claude-code
export const CLAUDE_COMPATIBLE_MODELS = [
    'qwen3-coder',
    'glm-4.7',
    'gpt-oss:20b',
    'gpt-oss:120b',
];

/**
 * Returns true if the given model name is a Claude-compatible model
 * that should be routed through ClaudeOllamaClient.
 */
export function isClaudeModel(modelName: string): boolean {
    return CLAUDE_COMPATIBLE_MODELS.some(m => modelName === m || modelName.startsWith(m + ':'));
}

interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

interface ChatRequest {
    model: string;
    messages: ChatMessage[];
    stream: boolean;
    options?: {
        num_predict?: number;
        temperature?: number;
    };
}

interface ChatStreamChunk {
    model: string;
    created_at: string;
    message?: {
        role: string;
        content: string;
    };
    done: boolean;
}

/**
 * Client for Claude-compatible models exposed via Ollama's /api/chat endpoint.
 * Uses the multi-turn chat format which is more natural for these models.
 *
 * Usage: set ANTHROPIC_BASE_URL=http://localhost:11434 and
 *        ANTHROPIC_AUTH_TOKEN=ollama for Claude Code CLI compatibility,
 *        but this client talks directly to Ollama's native API.
 */
export class ClaudeOllamaClient {
    private serverUrl: string;

    constructor(serverUrl: string = 'http://localhost:11434') {
        this.serverUrl = serverUrl;
    }

    updateServerUrl(serverUrl: string): void {
        this.serverUrl = serverUrl;
    }

    /**
     * Stream a chat response using Ollama's /api/chat endpoint.
     * Accepts the full conversation history for proper multi-turn context.
     */
    async generateChatStream(
        messages: Array<{ role: 'user' | 'assistant'; content: string }>,
        systemPrompt: string,
        config: LocalCopilotConfig,
        callbacks: StreamCallbacks,
        signal?: AbortSignal
    ): Promise<void> {
        const chatMessages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            ...messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
        ];

        const request: ChatRequest = {
            model: config.model,
            messages: chatMessages,
            stream: true,
            options: {
                num_predict: 2048,
                temperature: 0.7,
            },
        };

        return new Promise((resolve, reject) => {
            const url = new URL('/api/chat', this.serverUrl);
            const isHttps = url.protocol === 'https:';
            const lib = isHttps ? https : http;

            const options: http.RequestOptions = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                timeout: 180000, // 3 minutes for potentially large models
            };

            let fullResponse = '';

            const req = lib.request(options, (res) => {
                if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
                    const err = new Error(`Ollama /api/chat returned HTTP ${res.statusCode}`);
                    callbacks.onError?.(err);
                    reject(err);
                    return;
                }

                res.setEncoding('utf8');
                let buffer = '';

                res.on('data', (chunk: string) => {
                    buffer += chunk;
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (!line.trim()) { continue; }
                        try {
                            const data = JSON.parse(line) as ChatStreamChunk;
                            const token = data.message?.content ?? '';
                            if (token) {
                                fullResponse += token;
                                callbacks.onToken?.(token);
                            }
                            if (data.done) {
                                callbacks.onComplete?.(fullResponse);
                                resolve();
                            }
                        } catch {
                            // Ignore malformed partial chunks
                        }
                    }
                });

                res.on('end', () => {
                    if (buffer.trim()) {
                        try {
                            const data = JSON.parse(buffer) as ChatStreamChunk;
                            const token = data.message?.content ?? '';
                            if (token) {
                                fullResponse += token;
                                callbacks.onToken?.(token);
                            }
                        } catch { /* ignore */ }
                    }
                    // Ensure onComplete fires even if 'done' chunk was missing
                    callbacks.onComplete?.(fullResponse);
                    resolve();
                });
            });

            req.on('error', (error) => {
                callbacks.onError?.(error);
                reject(error);
            });

            req.on('timeout', () => {
                req.destroy();
                const error = new Error('Claude model request timed out');
                callbacks.onError?.(error);
                reject(error);
            });

            if (signal) {
                signal.addEventListener('abort', () => {
                    req.destroy();
                    const abortError = new Error('Request aborted');
                    abortError.name = 'AbortError';
                    reject(abortError);
                });
            }

            req.write(JSON.stringify(request));
            req.end();
        });
    }

    /**
     * Non-streaming chat for fallback scenarios.
     */
    async generateChat(
        messages: Array<{ role: 'user' | 'assistant'; content: string }>,
        systemPrompt: string,
        config: LocalCopilotConfig,
        signal?: AbortSignal
    ): Promise<string | null> {
        const chatMessages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            ...messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
        ];

        const request: ChatRequest = {
            model: config.model,
            messages: chatMessages,
            stream: false,
            options: {
                num_predict: 2048,
                temperature: 0.7,
            },
        };

        return new Promise((resolve, reject) => {
            const url = new URL('/api/chat', this.serverUrl);
            const isHttps = url.protocol === 'https:';
            const lib = isHttps ? https : http;

            const opts: http.RequestOptions = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                timeout: 120000,
            };

            let data = '';

            const req = lib.request(opts, (res) => {
                res.on('data', (c) => { data += c; });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data) as { message?: { content: string } };
                        resolve(parsed.message?.content?.trim() ?? null);
                    } catch {
                        resolve(null);
                    }
                });
            });

            req.on('error', (err) => {
                console.error('ClaudeOllamaClient error:', err);
                reject(err);
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timed out'));
            });

            if (signal) {
                signal.addEventListener('abort', () => {
                    req.destroy();
                    const e = new Error('Request aborted');
                    e.name = 'AbortError';
                    reject(e);
                });
            }

            req.write(JSON.stringify(request));
            req.end();
        });
    }
}

// Singleton
let claudeClientInstance: ClaudeOllamaClient | null = null;

export function getClaudeOllamaClient(serverUrl?: string): ClaudeOllamaClient {
    if (!claudeClientInstance) {
        claudeClientInstance = new ClaudeOllamaClient(serverUrl);
    } else if (serverUrl) {
        claudeClientInstance.updateServerUrl(serverUrl);
    }
    return claudeClientInstance;
}
