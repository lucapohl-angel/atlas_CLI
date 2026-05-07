import type { FormEvent, ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type VsCodeApi = {
  postMessage(message: unknown): void;
};

type BridgeMessage =
  | { readonly requestId: string; readonly kind: 'response'; readonly result: unknown }
  | { readonly requestId: string; readonly kind: 'error'; readonly error: { readonly message: string; readonly code?: string } }
  | { readonly requestId: string; readonly kind: 'stream-event'; readonly event: unknown };

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

function App(): ReactElement {
  const [prompt, setPrompt] = useState('');
  const [messages, setMessages] = useState<readonly string[]>(['Atlas host ready.']);

  const appendMessage = useCallback((message: string) => {
    setMessages((current) => [...current.slice(-20), message]);
  }, []);

  useEffect(() => {
    const listener = (event: MessageEvent<BridgeMessage>) => {
      const message = event.data;
      if (message.kind === 'response') {
        appendMessage(`response ${message.requestId}: ${JSON.stringify(message.result)}`);
        return;
      }
      if (message.kind === 'error') {
        appendMessage(`error ${message.requestId}: ${message.error.message}`);
        return;
      }
      appendMessage(`stream ${message.requestId}: ${JSON.stringify(message.event)}`);
    };

    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [appendMessage]);

  const sendPing = useCallback(() => {
    vscode.postMessage({ requestId: createRequestId(), kind: 'ping', params: {} });
  }, []);

  const sendPrompt = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextPrompt = prompt.trim();
    if (nextPrompt.length === 0) return;
    appendMessage(`you: ${nextPrompt}`);
    appendMessage('running...');
    vscode.postMessage({ requestId: createRequestId(), kind: 'runTurn', params: { prompt: nextPrompt } });
    setPrompt('');
  }, [appendMessage, prompt]);

  return (
    <main className="shell">
      <header className="header">
        <div>
          <p className="eyebrow">ATLAS.OS</p>
          <h1>Atlas</h1>
        </div>
        <button type="button" className="ghostButton" onClick={sendPing}>Ping</button>
      </header>

      <section className="log" aria-live="polite">
        {messages.map((message, index) => (
          <p key={`${index}-${message}`}>{message}</p>
        ))}
      </section>

      <form className="composer" onSubmit={sendPrompt}>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.currentTarget.value)}
          rows={4}
          placeholder="Ask Atlas"
        />
        <button type="submit">Send</button>
      </form>
    </main>
  );
}

function createRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const app = document.querySelector('#app');
if (!(app instanceof HTMLElement)) {
  throw new Error('Atlas webview root was not found.');
}

createRoot(app).render(<App />);
