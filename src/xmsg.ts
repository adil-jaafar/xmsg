interface RPCCallRequest {
    type: 'rpc_call';
    id: string;
    method: string;
    params: any[];
    sessionId: string;
}

interface RPCResponse {
    type: 'rpc_response';
    id: string;
    result: any;
    error: string | null;
    sessionId: string;
}

interface RPCConnectRequest {
    type: 'rpc_connect';
    sessionId: string;
}

interface RPCConnectAck {
    type: 'rpc_connect_ack';
    sessionId: string;
    exposedFunctions: string[];
}

interface RPCConnectError {
    type: 'rpc_connect_error';
    error: string;
    sessionId: string;
}

interface RPCKeepAlive {
    type: 'rpc_keep_alive';
    sessionId: string;
}

type RPCMessage =
    | RPCCallRequest
    | RPCResponse
    | RPCConnectRequest
    | RPCConnectAck
    | RPCConnectError
    | RPCKeepAlive;

interface ExposedFunctions {
    [methodName: string]: (...args: any[]) => any;
}

interface XmsgOptions {
    keepAliveInterval?: number;
}

class Xmsg extends EventTarget {
    private targetWindow: Window;
    private targetOrigin: string;
    private exposedFunctions: ExposedFunctions;
    private isConnected = false;
    private pendingCalls = new Map<string, { resolve: (value: any) => void; reject: (error: any) => void }>();
    private sessionId: string;
    private keepAliveInterval: NodeJS.Timeout | null = null;
    private keepAliveIntervalTime: number;
    private windowCheckInterval: NodeJS.Timeout | null = null;

    constructor(
        targetWindow: Window,
        targetOrigin: string = '*',
        exposedFunctions: ExposedFunctions = {},
        options: XmsgOptions = {}
    ) {
        super();

        if (!targetWindow || typeof targetWindow.postMessage !== 'function') {
            throw new Error("Invalid targetWindow: must have a postMessage method.");
        }

        this.targetWindow = targetWindow;
        this.targetOrigin = targetOrigin;
        this.exposedFunctions = exposedFunctions;
        this.keepAliveIntervalTime = options.keepAliveInterval ?? 30000;
        this.sessionId = this.generateUUID();

        window.addEventListener('message', this.handleMessage.bind(this));

        // Vérifier périodiquement si la fenêtre est fermée
        this.startWindowCheck();
    }

    private createFunctionProxies(exposedFunctionsNames: string[]): void {
        exposedFunctionsNames.forEach((methodName) => {
            (this as any)[methodName] = (...params: any[]) => this.call(methodName, ...params);
        });
    }

    async connect(): Promise<void> {
        if (this.isConnected) return;
        
        console.log("[Xmsg] Connecting...");

        this.targetWindow.postMessage({ type: 'rpc_connect_ack', sessionId: this.sessionId, exposedFunctions: Object.keys(this.exposedFunctions) }, this.targetOrigin);
        
        return new Promise<void>((resolve, reject) => {
            const onSuccess = () => {
                this.removeEventListener('connected', onSuccess);
                resolve();
            };

            this.addEventListener('connected', onSuccess);
        });
    }

    private async call(method: string, ...params: any[]): Promise<any> {
        if (!this.isConnected) throw new Error("Not connected. Call connect() first.");

        const id = this.generateUUID();
        const request: RPCCallRequest = { type: 'rpc_call', id, method, params, sessionId: this.sessionId };

        return new Promise((resolve, reject) => {
            this.pendingCalls.set(id, { resolve, reject });

            this.targetWindow.postMessage(request, this.targetOrigin);

            setTimeout(() => {
                if (this.pendingCalls.has(id)) {
                    this.pendingCalls.delete(id);
                    reject(new Error(`RPC call timed out: ${method}`));
                }
            }, 10000); // Timeout par appel, mais pas de déconnexion forcée
        });
    }

    private handleMessage(event: MessageEvent): void {
        if (this.targetOrigin !== '*' && event.origin !== this.targetOrigin) return;
        const message = event.data as RPCMessage;

        if (!message || typeof message !== 'object' || !message.type) return;

        switch (message.type) {
            case 'rpc_response':
                this.handleRpcResponse(message);
                break;
            case 'rpc_connect_ack':
                this.handleConnectAck(message);
                break;
            case 'rpc_connect_error':
                this.handleConnectError(message);
                break;
            case 'rpc_keep_alive':
                break;
            case 'rpc_call':
                this.handleRpcCall(message);
                break;
        }
    }

    private handleRpcResponse(message: RPCResponse): void {
        const pendingCall = this.pendingCalls.get(message.id);
        if (!pendingCall) return;

        this.pendingCalls.delete(message.id);
        message.error ? pendingCall.reject(new Error(message.error)) : pendingCall.resolve(message.result);
    }

    private async handleRpcCall(message: RPCCallRequest): Promise<void> {
        if (message.sessionId !== this.sessionId) return;

        try {
            const result = await this.exposedFunctions[message.method](...message.params);
            this.targetWindow.postMessage({ type: 'rpc_response', id: message.id, result, sessionId: message.sessionId }, this.targetOrigin);
        } catch (error: any) {
            this.targetWindow.postMessage({ type: 'rpc_response', id: message.id, error: error.message, sessionId: message.sessionId }, this.targetOrigin);
        }
    }

    private handleConnectAck(message: RPCConnectAck): void {
        if( message.sessionId !== this.sessionId ) {
            this.sessionId = message.sessionId;
            this.targetWindow.postMessage({ type: 'rpc_connect_ack', sessionId: this.sessionId, exposedFunctions: Object.keys(this.exposedFunctions) }, this.targetOrigin);
        }
        this.createFunctionProxies(message.exposedFunctions);
        this.isConnected = true;
        console.log("[Xmsg] Connected!");
        this.dispatchEvent(new Event('connected'));
        this.startKeepAlive();
    }

    private handleConnectError(message: RPCConnectError): void {
        console.error("[Xmsg] Connection error:", message.error);
    }

    disconnect(reason: string = "Disconnected"): void {
        if (!this.isConnected) return;

        console.warn(`[Xmsg] Disconnected: ${reason}`);
        this.isConnected = false;
        this.pendingCalls.clear();
        this.stopKeepAlive();
    }

    private startKeepAlive(): void {
        this.keepAliveInterval = setInterval(() => {
            if (!this.isConnected) return this.stopKeepAlive();
            this.targetWindow.postMessage({ type: 'rpc_keep_alive', sessionId: this.sessionId }, this.targetOrigin);
        }, this.keepAliveIntervalTime);
    }

    private stopKeepAlive(): void {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
    }

    private startWindowCheck(): void {
        this.windowCheckInterval = setInterval(() => {
            if (this.targetWindow.closed) {
                this.disconnect("Target window closed");
                clearInterval(this.windowCheckInterval!);
                this.windowCheckInterval = null;
            }
        }, 1000);
    }

    private generateUUID(): string {
        return crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }
}

(window as any).Xmsg = Xmsg;
