import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Icon } from '../components/icons';
import { Button, Field, inputClass, Modal, ToastHost, cx, useToast } from '../components/ui';
import '../styles.css';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

const KEY_STORAGE = 'lwrr.chat.key';
const MODEL_STORAGE = 'lwrr.chat.model';

/**
 * Chat talks to the public /v1 surface with an API key rather than the console
 * session, so it exercises exactly the same path a customer integration uses.
 * The key is held in sessionStorage: it disappears when the tab closes instead
 * of persisting on a shared machine.
 */
function useApiKey() {
  const [key, setKey] = useState(() => sessionStorage.getItem(KEY_STORAGE) ?? '');
  const save = useCallback((value: string) => {
    sessionStorage.setItem(KEY_STORAGE, value);
    setKey(value);
  }, []);
  return { key, save };
}

function Composer({
  onSend,
  busy,
  onStop
}: {
  onSend: (text: string) => void;
  busy: boolean;
  onStop: () => void;
}) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow with the content up to a ceiling, so a long prompt stays visible but
  // never pushes the conversation off screen.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
  }, [value]);

  function submit() {
    const text = value.trim();
    if (!text || busy) return;
    onSend(text);
    setValue('');
  }

  return (
    <div className="border-t border-border bg-surface/95 p-3 backdrop-blur">
      <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
        <textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter inserts a newline. IME composition is
            // excluded so typing in Japanese or Chinese does not submit early.
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="Send a message…"
          aria-label="Message"
          className={cx(
            inputClass,
            'max-h-[200px] flex-1 resize-none py-2.5 leading-relaxed'
          )}
        />
        {busy ? (
          <Button variant="outline" onClick={onStop} aria-label="Stop generating" className="h-[42px] w-[42px] px-0">
            <Icon name="close" size={16} />
          </Button>
        ) : (
          <Button
            onClick={submit}
            disabled={value.trim().length === 0}
            aria-label="Send message"
            className="h-[42px] w-[42px] px-0"
          >
            <Icon name="send" size={16} />
          </Button>
        )}
      </div>
      <p className="mx-auto mt-1.5 w-full max-w-3xl text-center text-[11px] text-muted">
        Enter to send · Shift + Enter for a new line
      </p>
    </div>
  );
}

function Chat() {
  const toast = useToast();
  const { key, save } = useApiKey();
  const [model, setModel] = useState(() => localStorage.getItem(MODEL_STORAGE) ?? 'lwrr-text');
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(!key);
  const [draftKey, setDraftKey] = useState(key);
  const controller = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  async function send(text: string) {
    if (!key) {
      setSettingsOpen(true);
      return;
    }
    const history: Message[] = [...messages, { role: 'user', content: text }];
    setMessages([...history, { role: 'assistant', content: '' }]);
    setBusy(true);
    controller.current = new AbortController();

    try {
      const response = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, stream: true, messages: history }),
        signal: controller.current.signal
      });

      if (!response.ok || !response.body) {
        const detail = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        throw new Error(detail?.error?.message ?? `Request failed (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // Server-sent events arrive in arbitrary chunks, so only complete
      // \n\n delimited frames are parsed and the remainder is carried over.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const line = frame.split('\n').find((part) => part.startsWith('data:'));
          if (!line) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const delta = parsed.choices?.[0]?.delta?.content;
            if (!delta) continue;
            setMessages((current) => {
              const next = [...current];
              const last = next[next.length - 1];
              if (last && last.role === 'assistant') {
                next[next.length - 1] = { role: 'assistant', content: last.content + delta };
              }
              return next;
            });
          } catch {
            // A malformed frame is skipped rather than ending the stream.
          }
        }
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        toast('Generation stopped');
      } else {
        toast((error as Error).message, 'bad');
        setMessages((current) => current.filter((message, index) => index !== current.length - 1 || message.content));
      }
    } finally {
      setBusy(false);
      controller.current = null;
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon name="message" size={18} className="text-brand" animate />
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold tracking-tight">Chat room</h1>
            <p className="truncate text-xs text-muted">{model}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" onClick={() => setMessages([])} aria-label="Clear conversation">
            <Icon name="trash" size={16} />
          </Button>
          <Button variant="ghost" onClick={() => setSettingsOpen(true)} aria-label="Settings">
            <Icon name="settings" size={16} />
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-4 p-4">
          {messages.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-20 text-center text-sm text-muted">
              <Icon name="bot" size={26} animate />
              Start a conversation. Your messages run through the same API your integrations use.
            </div>
          )}
          {messages.map((message, index) => (
            <div
              key={index}
              className={cx('flex gap-2.5', message.role === 'user' ? 'justify-end' : 'justify-start')}
            >
              {message.role === 'assistant' && (
                <div className="mt-1 hidden h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-surface sm:flex">
                  <Icon name="bot" size={14} className="text-brand" />
                </div>
              )}
              <div
                className={cx(
                  'animate-rise max-w-[85%] whitespace-pre-wrap break-words rounded-card px-3.5 py-2.5 text-sm leading-relaxed sm:max-w-[75%]',
                  message.role === 'user'
                    ? 'bg-brand text-white'
                    : 'border border-border bg-surface text-ink'
                )}
              >
                {message.content || (
                  <span className="inline-flex items-center gap-1.5 text-muted">
                    <Icon name="spinner" size={13} spin /> Thinking
                  </span>
                )}
              </div>
            </div>
          ))}
          <div ref={bottom} />
        </div>
      </div>

      <Composer onSend={(text) => void send(text)} busy={busy} onStop={() => controller.current?.abort()} />

      <Modal open={settingsOpen} title="Connection" onClose={() => setSettingsOpen(false)}>
        <div className="space-y-4">
          <Field
            label="API key"
            hint="Create one on the member dashboard. It is kept in this tab only and cleared when the tab closes."
          >
            <input
              className={inputClass}
              type="password"
              autoComplete="off"
              value={draftKey}
              onChange={(event) => setDraftKey(event.target.value)}
              placeholder="lwrr_live_…"
            />
          </Field>
          <Field label="Model">
            <input
              className={inputClass}
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setSettingsOpen(false)}>
              Cancel
            </Button>
            <Button
              icon="check"
              onClick={() => {
                save(draftKey.trim());
                localStorage.setItem(MODEL_STORAGE, model);
                setSettingsOpen(false);
                toast('Connection saved');
              }}
            >
              Save
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <ToastHost>
      <Chat />
    </ToastHost>
  </StrictMode>
);
