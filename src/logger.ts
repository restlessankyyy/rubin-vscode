import * as vscode from 'vscode';

/**
 * Log levels for the Rubin extension
 */
export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
}

/**
 * Centralized logger for the Rubin extension.
 * Provides consistent logging across all modules with output channel support.
 */
class Logger {
    private outputChannel: vscode.OutputChannel | null = null;
    private logLevel: LogLevel = LogLevel.INFO;

    /**
     * Initialize the logger with a VS Code output channel
     */
    init(context: vscode.ExtensionContext): void {
        this.outputChannel = vscode.window.createOutputChannel('Rubin');
        context.subscriptions.push(this.outputChannel);
    }

    /**
     * Set the minimum log level
     */
    setLogLevel(level: LogLevel): void {
        this.logLevel = level;
    }

    /**
     * Format a log message with timestamp
     */
    private formatMessage(level: string, message: string): string {
        const timestamp = new Date().toISOString();
        return `[${timestamp}] [${level}] ${message}`;
    }

    /**
     * Write to output channel and console
     */
    private log(level: LogLevel, levelName: string, message: string, ...args: unknown[]): void {
        if (level < this.logLevel) {
            return;
        }

        const formattedMessage = this.formatMessage(levelName, message);
        const fullMessage = args.length > 0 
            ? `${formattedMessage} ${args.map(a => JSON.stringify(a)).join(' ')}`
            : formattedMessage;

        // Write to output channel
        if (this.outputChannel) {
            this.outputChannel.appendLine(fullMessage);
        }

        // Also log to console for debugging
        switch (level) {
            case LogLevel.DEBUG:
            case LogLevel.INFO:
                console.log(fullMessage);
                break;
            case LogLevel.WARN:
                console.warn(fullMessage);
                break;
            case LogLevel.ERROR:
                console.error(fullMessage);
                break;
        }
    }

    debug(message: string, ...args: unknown[]): void {
        this.log(LogLevel.DEBUG, 'DEBUG', message, ...args);
    }

    info(message: string, ...args: unknown[]): void {
        this.log(LogLevel.INFO, 'INFO', message, ...args);
    }

    warn(message: string, ...args: unknown[]): void {
        this.log(LogLevel.WARN, 'WARN', message, ...args);
    }

    error(message: string, error?: Error | unknown, ...args: unknown[]): void {
        let errorDetails = '';
        if (error instanceof Error) {
            errorDetails = ` | Error: ${error.message}`;
            if (error.stack) {
                errorDetails += `\nStack: ${error.stack}`;
            }
        } else if (error !== undefined) {
            errorDetails = ` | ${JSON.stringify(error)}`;
        }
        this.log(LogLevel.ERROR, 'ERROR', message + errorDetails, ...args);
    }

    /**
     * Show the output channel to the user
     */
    show(): void {
        this.outputChannel?.show();
    }
}

// Singleton instance
export const logger = new Logger();
