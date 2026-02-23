import * as https from 'https';
import { StreamCallbacks } from './ollamaClient';

export const ANTHROPIC_API_BASE = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2023-06-01';

// Real Claude models available via Anthropic API
export const CLAUDE_API_MODELS: { id: string; label: string }[] = [
    { id: 'claude-opus-4-5', label: 'Claude Opus 4 (Most Powerful)' },
    { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4 (Recommended)' },
    { id: 'claude-haiku-3-5', label: 'Claude Haiku 3.5 (Fastest)' },
    { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
    { id: 'claude-3-opus-20240229', label: 'Claude 3 Opus' },
    { id: 'claude-3-haiku-20240307', label: 'Claude 3 Haiku' },
];

export const CLAUDE_API_MODEL_IDS = CLAUDE_API_MODELS.map(m => m.id);

export function isAnthropicModel(modelId: string): boolean {
    return CLAUDE_API_MODEL_IDS.includes(modelId);
}

interface AnthropicMessage {
    role: 'user' | 'assistant';
    content: string;
}

interface AnthropicRequest {
    model: string;
    max_tokens: number;
    system?: string;
    messages: AnthropicMessage[];
    stream: boolean;
}

export class AnthropicClient {
    private apiKey: string;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    updateApiKey(apiKey: string) {
        this.apiKey = apiKey;
    }

    /**
     * Stream a chat response using the Anthropic Messages API with SSE.
     */
    async generateChatStream(
        messages: Array<{ role: 'user' | 'assistant'; content: string }>,
        systemPrompt: string,
        model: string,
        maxTokens: number = 4096,
        callbacks: StreamCallbacks,
        signal?: AbortSignal
    ): Promise<void> {
        const body: AnthropicRequest = {
            model,
            max_tokens: maxTokens,
            system: systemPrompt,
            messages: messages.map(m => ({ role: m.role, content: m.content })),
            stream: true,
        };

        return new Promise((resolve, reject) => {
            const options: https.RequestOptions = {
                hostname: 'api.anthropic.com',
                port: 443,
                path: '/v1/messages',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.apiKey,
                    'anthropic-version': ANTHROPIC_VERSION,
                },
                timeout: 180000,
            };

            let fullResponse = '';

            const req = https.request(options, (res) => {
                // Handle auth / rate limit errors
                if (res.statusCode === 401) {
                    const err = new Error('Invalid Anthropic API key. Run "Rubin: Set Anthropic API Key" to update it.');
                    callbacks.onError?.(err);
                    reject(err);
                    return;
                }
                if (res.statusCode === 429) {
                    const err = new Error('Anthropic rate limit reached. Please wait a moment before trying again.');
                    callbacks.onError?.(err);
                    reject(err);
                    return;
                }
                if (res.statusCode === 529) {
                    const err = new Error('Anthropic API is overloaded. Please try again shortly.');
                    callbacks.onError?.(err);
                    reject(err);
                    return;
                }
                if (res.statusCode && res.statusCode >= 400) {
                    const err = new Error(`Anthropic API error: HTTP ${res.statusCode}`);
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
                        if (!line.startsWith('data: ')) { continue; }
                        const data = line.slice(6).trim();
                        if (data === '[DONE]' || data === '') { continue; }

                        try {
                            const event = JSON.parse(data) as {
                                type: string;
                                delta?: { type: string; text?: string };
                            };
                            if (event.type === 'content_block_delta' && event.delta?.text) {
                                fullResponse += event.delta.text;
                                callbacks.onToken?.(event.delta.text);
                            }
                            if (event.type === 'message_stop') {
                                callbacks.onComplete?.(fullResponse);
                                resolve();
                            }
                        } catch {
                            // Ignore malformed SSE lines
                        }
                    }
                });

                res.on('end', () => {
                    // Ensure completion fires even if message_stop wasn't received
                    callbacks.onComplete?.(fullResponse);
                    resolve();
                });
            });

            req.on('error', (err) => {
                callbacks.onError?.(err);
                reject(err);
            });

            req.on('timeout', () => {
                req.destroy();
                const err = new Error('Anthropic API request timed out');
                callbacks.onError?.(err);
                reject(err);
            });

            if (signal) {
                signal.addEventListener('abort', () => {
                    req.destroy();
                    const e = new Error('Request aborted');
                    e.name = 'AbortError';
                    reject(e);
                });
            }

            req.write(JSON.stringify(body));
            req.end();
        });
    }

    /**
     * Non-streaming fallback.
     */
    async generateChat(
        messages: Array<{ role: 'user' | 'assistant'; content: string }>,
        systemPrompt: string,
        model: string,
        maxTokens: number = 4096
    ): Promise<string | null> {
        const body: AnthropicRequest = {
            model,
            max_tokens: maxTokens,
            system: systemPrompt,
            messages: messages.map(m => ({ role: m.role, content: m.content })),
            stream: false,
        };

        return new Promise((resolve, reject) => {
            const options: https.RequestOptions = {
                hostname: 'api.anthropic.com',
                port: 443,
                path: '/v1/messages',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.apiKey,
                    'anthropic-version': ANTHROPIC_VERSION,
                },
                timeout: 120000,
            };

            let data = '';
            const req = https.request(options, (res) => {
                res.on('data', (c) => { data += c; });
                res.on('end', () => {
                    try {
                        if (res.statusCode === 401) {
                            resolve(null);
                            return;
                        }
                        const parsed = JSON.parse(data) as { content?: Array<{ text: string }> };
                        resolve(parsed.content?.[0]?.text?.trim() ?? null);
                    } catch { resolve(null); }
                });
            });

            req.on('error', (err) => reject(err));
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
            req.write(JSON.stringify(body));
            req.end();
        });
    }
}

// Singleton
let anthropicInstance: AnthropicClient | null = null;

export function getAnthropicClient(apiKey: string): AnthropicClient {
    if (!anthropicInstance) {
        anthropicInstance = new AnthropicClient(apiKey);
    } else {
        anthropicInstance.updateApiKey(apiKey);
    }
    return anthropicInstance;
}
