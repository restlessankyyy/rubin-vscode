import * as https from 'https';
import * as http from 'http';
import { LocalCopilotConfig } from './config';

export interface GenerateRequest {
    model: string;
    prompt: string;
    stream: boolean;
    options?: {
        num_predict?: number;
        temperature?: number;
        top_p?: number;
        stop?: string[];
    };
}

export interface StreamChunk {
    model: string;
    created_at: string;
    response: string;
    done: boolean;
    context?: number[];
    total_duration?: number;
    load_duration?: number;
    prompt_eval_count?: number;
    eval_count?: number;
    eval_duration?: number;
}

export interface StreamCallbacks {
    onToken?: (token: string) => void;
    onComplete?: (fullResponse: string) => void;
    onError?: (error: Error) => void;
}

export interface GenerateResponse {
    model: string;
    created_at: string;
    response: string;
    done: boolean;
    context?: number[];
    total_duration?: number;
    load_duration?: number;
    prompt_eval_count?: number;
    eval_count?: number;
}

export interface ModelInfo {
    name: string;
    modified_at: string;
    size: number;
}

export interface TagsResponse {
    models: ModelInfo[];
}

export class OllamaClient {
    private serverUrl: string;
    private abortController: AbortController | null = null;

    constructor(serverUrl: string = 'http://localhost:11434') {
        this.serverUrl = serverUrl;
    }

    updateServerUrl(serverUrl: string): void {
        this.serverUrl = serverUrl;
    }

    async checkConnection(): Promise<boolean> {
        try {
            const response = await this.request<TagsResponse>('/api/tags', 'GET');
            return response !== null;
        } catch {
            return false;
        }
    }

    async getAvailableModels(): Promise<string[]> {
        try {
            const response = await this.request<TagsResponse>('/api/tags', 'GET');
            if (response && response.models) {
                return response.models.map(m => m.name);
            }
            return [];
        } catch {
            return [];
        }
    }

    async generateCompletion(
        prompt: string,
        config: LocalCopilotConfig,
        signal?: AbortSignal
    ): Promise<string | null> {
        const request: GenerateRequest = {
            model: config.model,
            prompt: prompt,
            stream: false,
            options: {
                num_predict: config.maxTokens,
                temperature: config.temperature,
                stop: ['\n\n', '```', '// End', '# End'],
            },
        };

        try {
            const response = await this.request<GenerateResponse>(
                '/api/generate',
                'POST',
                request,
                signal
            );

            if (response && response.response) {
                return this.cleanCompletionResponse(response.response);
            }
            return null;
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                return null;
            }
            console.error('Ollama generate error:', error);
            return null;
        }
    }

    async generateChat(
        prompt: string,
        config: LocalCopilotConfig,
        signal?: AbortSignal
    ): Promise<string | null> {
        const request: GenerateRequest = {
            model: config.model,
            prompt: prompt,
            stream: false,
            options: {
                num_predict: 1024, // More tokens for chat responses
                temperature: 0.7, // Slightly more creative for chat
            },
        };

        try {
            const response = await this.request<GenerateResponse>(
                '/api/generate',
                'POST',
                request,
                signal
            );

            if (response && response.response) {
                return response.response.trim();
            }
            return null;
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                return null;
            }
            console.error('Ollama chat error:', error);
            return null;
        }
    }

    /**
     * Generate a streaming chat response - tokens are delivered in real-time
     */
    async generateChatStream(
        prompt: string,
        config: LocalCopilotConfig,
        callbacks: StreamCallbacks,
        signal?: AbortSignal
    ): Promise<void> {
        const request: GenerateRequest = {
            model: config.model,
            prompt: prompt,
            stream: true,
            options: {
                num_predict: 2048,
                temperature: 0.7,
            },
        };

        return new Promise((resolve, reject) => {
            const url = new URL('/api/generate', this.serverUrl);
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
                timeout: 120000, // 2 minutes for streaming
            };

            let fullResponse = '';

            const req = lib.request(options, (res) => {
                res.setEncoding('utf8');
                let buffer = '';

                res.on('data', (chunk: string) => {
                    buffer += chunk;
                    
                    // Process complete JSON lines
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || ''; // Keep incomplete line in buffer

                    for (const line of lines) {
                        if (!line.trim()) { continue; }
                        
                        try {
                            const data = JSON.parse(line) as StreamChunk;
                            
                            if (data.response) {
                                fullResponse += data.response;
                                callbacks.onToken?.(data.response);
                            }
                            
                            if (data.done) {
                                callbacks.onComplete?.(fullResponse);
                                resolve();
                            }
                        } catch (parseError) {
                            // Ignore parse errors for incomplete chunks
                        }
                    }
                });

                res.on('end', () => {
                    // Process any remaining buffer
                    if (buffer.trim()) {
                        try {
                            const data = JSON.parse(buffer) as StreamChunk;
                            if (data.response) {
                                fullResponse += data.response;
                                callbacks.onToken?.(data.response);
                            }
                        } catch { /* ignore */ }
                    }
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
                const error = new Error('Request timeout');
                callbacks.onError?.(error);
                reject(error);
            });

            // Handle abort signal
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
     * Generate embeddings for semantic search (if model supports it)
     */
    async generateEmbedding(text: string, model: string = 'nomic-embed-text'): Promise<number[] | null> {
        try {
            const response = await this.request<{ embedding: number[] }>(
                '/api/embeddings',
                'POST',
                { model, prompt: text }
            );
            return response?.embedding || null;
        } catch {
            return null;
        }
    }

    cancelPendingRequests(): void {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
    }

    private cleanCompletionResponse(response: string): string {
        // Remove any leading/trailing whitespace
        let cleaned = response.trim();

        // Remove common artifacts from code completion
        // If the response starts with the prompt continuation, keep it
        // Remove markdown code blocks if present
        cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');

        // Limit to a reasonable number of lines for inline completion
        const lines = cleaned.split('\n');
        if (lines.length > 10) {
            cleaned = lines.slice(0, 10).join('\n');
        }

        return cleaned;
    }

    private async request<T>(
        path: string,
        method: 'GET' | 'POST',
        body?: unknown,
        signal?: AbortSignal
    ): Promise<T | null> {
        return new Promise((resolve, reject) => {
            const url = new URL(path, this.serverUrl);
            const isHttps = url.protocol === 'https:';
            const lib = isHttps ? https : http;

            const options: http.RequestOptions = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname,
                method: method,
                headers: {
                    'Content-Type': 'application/json',
                },
                timeout: 30000,
            };

            const req = lib.request(options, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                            const parsed = JSON.parse(data) as T;
                            resolve(parsed);
                        } else {
                            console.error(`Ollama API error: ${res.statusCode} - ${data}`);
                            resolve(null);
                        }
                    } catch (parseError) {
                        console.error('Failed to parse Ollama response:', parseError);
                        resolve(null);
                    }
                });
            });

            req.on('error', (error) => {
                console.error('Ollama request error:', error);
                reject(error);
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });

            // Handle abort signal
            if (signal) {
                signal.addEventListener('abort', () => {
                    req.destroy();
                    const abortError = new Error('Request aborted');
                    abortError.name = 'AbortError';
                    reject(abortError);
                });
            }

            if (body) {
                req.write(JSON.stringify(body));
            }

            req.end();
        });
    }
}

// Singleton instance
let clientInstance: OllamaClient | null = null;

export function getOllamaClient(serverUrl?: string): OllamaClient {
    if (!clientInstance) {
        clientInstance = new OllamaClient(serverUrl);
    } else if (serverUrl) {
        clientInstance.updateServerUrl(serverUrl);
    }
    return clientInstance;
}
