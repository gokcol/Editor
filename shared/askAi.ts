import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { buildAiPrompt, createAiRequestGate, type AiContext, type AiContextChoice } from './aiPrompt';
import './askAi.css';

type AiStatus = { available: boolean; signedIn: boolean; message: string };
type Options = {
  context: AiContext;
  initialPrompt?: string;
  openDraft: (reply: string) => void;
  reviewReply?: (reply: string) => boolean;
  openPromptStudio?: () => void;
};
let activeDialog: HTMLDialogElement | null = null;
// Volatile only: never put prompts or answers into localStorage/session logs.
let lastPrompt = '';
let lastReply = '';
export function isAskAiOpen() { return activeDialog !== null; }

export async function showAskAi(options: Options) {
  if (activeDialog) { activeDialog.querySelector<HTMLTextAreaElement>('.ask-ai-prompt')?.focus(); return; }
  const previousFocus = document.activeElement;
  const dialog = document.createElement('dialog');
  activeDialog = dialog;
  dialog.className = 'ask-ai';
  dialog.setAttribute('aria-labelledby', 'ask-ai-title');
  const shell = document.querySelector<HTMLElement>('.app-shell');
  const theme = shell?.dataset.theme;
  dialog.dataset.theme = theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme ?? 'dark';
  if (shell) {
    const style = getComputedStyle(shell);
    for (const [source, target] of [['--paper', '--ai-paper'], ['--ink', '--ai-ink'], ['--muted', '--ai-muted'], ['--line', '--ai-line'], ['--accent', '--ai-accent']]) {
      const value = style.getPropertyValue(source).trim();
      if (value) dialog.style.setProperty(target, value);
    }
  }
  // Static trusted markup only. Prompts, filenames and model output use .value
  // or textContent below; replies are never interpreted as HTML or scripts.
  dialog.innerHTML = `<header><div><small>Optional · powered by Codex</small><h2 id="ask-ai-title">Ask AI</h2></div><button class="ask-ai-close" type="button" aria-label="Close Ask AI">×</button></header>
    <p class="ask-ai-account" role="status">Checking Codex…</p>
    <div class="ask-ai-connection"><button class="ask-ai-login" type="button" hidden>Sign in with ChatGPT</button><button class="ask-ai-recheck" type="button">Check connection</button><span>No API key · subscription limits apply</span></div>
    <form class="ask-ai-form"><label>Your prompt<textarea class="ask-ai-prompt" rows="4" placeholder="Ask a question, rewrite a passage, or explain some code…" autofocus></textarea></label>
    <label class="ask-ai-context-label">Send context<select class="ask-ai-context"><option value="none">None — prompt only</option><option value="selection">Captured selection</option><option value="document">Captured document</option></select></label>
    <details class="ask-ai-context-preview" hidden><summary>Review the context being sent</summary><pre></pre></details>
    <p class="ask-ai-privacy">Send shares your prompt and chosen context with OpenAI. Nothing else from your project is attached. Each question starts a fresh, temporary session.</p>
    <div class="ask-ai-submit"><span class="ask-ai-status" role="status"></span><button class="ask-ai-stop" type="button" hidden>Stop</button><button class="ask-ai-send" type="submit">Send</button></div></form>
    <section class="ask-ai-answer"><label>Answer<textarea class="ask-ai-reply" rows="9" readonly placeholder="The answer will appear here. Your document stays unchanged."></textarea></label><div class="ask-ai-answer-actions"><button class="ask-ai-copy" type="button">Copy answer</button><button class="ask-ai-draft" type="button">Open as new draft</button><button class="ask-ai-review" type="button" hidden>Review in Prompt Studio…</button></div></section>
    <footer><span>Answers are never applied automatically.</span><button class="ask-ai-studio" type="button" hidden>Manual Prompt Studio…</button><button class="ask-ai-clear" type="button">Clear</button></footer>`;
  const element = <T extends HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  const prompt = element<HTMLTextAreaElement>('.ask-ai-prompt');
  const reply = element<HTMLTextAreaElement>('.ask-ai-reply');
  const choice = element<HTMLSelectElement>('.ask-ai-context');
  const send = element<HTMLButtonElement>('.ask-ai-send');
  const stop = element<HTMLButtonElement>('.ask-ai-stop');
  const login = element<HTMLButtonElement>('.ask-ai-login');
  const recheck = element<HTMLButtonElement>('.ask-ai-recheck');
  const status = element<HTMLElement>('.ask-ai-status');
  const account = element<HTMLElement>('.ask-ai-account');
  const copy = element<HTMLButtonElement>('.ask-ai-copy');
  const draft = element<HTMLButtonElement>('.ask-ai-draft');
  const review = element<HTMLButtonElement>('.ask-ai-review');
  const clear = element<HTMLButtonElement>('.ask-ai-clear');
  const gate = createAiRequestGate();
  let closed = false;
  let busy = false;
  let connected: AiStatus | null = null;
  let unlisten: (() => void) | undefined;
  prompt.value = options.initialPrompt ?? lastPrompt;
  reply.value = lastReply;
  choice.options[1].disabled = !options.context.selection;
  choice.options[1].textContent = `Captured selection (${options.context.selection.length.toLocaleString()} characters)`;
  choice.options[2].disabled = !options.context.document;
  choice.options[2].textContent = `Captured document: ${options.context.name || 'No document'} (${options.context.document.length.toLocaleString()} characters)`;
  review.hidden = !options.reviewReply;
  const updateActions = () => {
    send.disabled = busy || !connected?.signedIn || !prompt.value.trim();
    login.disabled = busy;
    recheck.disabled = busy;
    clear.disabled = busy;
    prompt.disabled = busy;
    choice.disabled = busy;
    stop.hidden = !busy;
    for (const button of [copy, draft, review]) button.disabled = busy || !reply.value.trim();
  };
  const cancel = () => {
    const id = gate.stop();
    if (id && isTauri()) void invoke('codex_ai_cancel', { requestId: id }).catch(() => {});
    busy = false;
    updateActions();
    status.textContent = 'Stopped. Your document is unchanged.';
  };
  const close = () => {
    if (closed) return;
    cancel();
    closed = true;
    lastPrompt = prompt.value;
    lastReply = reply.value;
    unlisten?.();
    activeDialog = null;
    dialog.remove();
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
  };
  const checkConnection = async () => {
    connected = null;
    updateActions();
    account.textContent = 'Checking Codex…';
    recheck.disabled = true;
    try {
      connected = isTauri() ? await invoke<AiStatus>('codex_ai_status') : { available: false, signedIn: false, message: 'Ask AI is available in the native macOS app. Manual Prompt Studio still works in the browser.' };
      if (closed) return;
      account.textContent = connected.message;
      login.hidden = !connected.available || connected.signedIn;
    } catch (error) {
      if (closed) return;
      account.textContent = String(error);
    }
    if (!closed) updateActions();
  };
  const perform = async (signIn: boolean) => {
    if (busy || closed) return;
    let payload: string;
    try { payload = signIn ? '' : buildAiPrompt(prompt.value, options.context, choice.value as AiContextChoice); }
    catch (error) { status.textContent = (error as Error).message; return; }
    const id = crypto.randomUUID();
    gate.begin(id);
    busy = true;
    updateActions();
    status.textContent = signIn ? 'Finish sign-in in your browser. This updates the shared Codex login.' : 'Waiting for Codex…';
    // Keep the previous answer until a new one succeeds; Stop/errors never
    // silently erase a useful reply.
    try {
      if (!signIn && !unlisten) {
        const listener = await listen<{ requestId: string; text: string }>('codex-ai-progress', (event) => {
          if (!closed && gate.accepts(event.payload.requestId)) reply.value = event.payload.text;
        });
        if (closed || !gate.accepts(id)) { listener(); return; }
        unlisten = listener;
      }
      if (!gate.accepts(id)) return;
      const answer = signIn
        ? await invoke('codex_ai_login', { requestId: id })
        : await invoke<string>('codex_ai_ask', { requestId: id, prompt: payload });
      if (closed || !gate.accepts(id)) return;
      if (!signIn) reply.value = String(answer);
      status.textContent = signIn ? 'Signed in with ChatGPT.' : 'Answer received. Your document is unchanged.';
      if (signIn) await checkConnection();
    } catch (error) {
      if (!closed && gate.accepts(id)) status.textContent = String(error);
    } finally {
      if (!closed && gate.accepts(id)) { gate.stop(); busy = false; updateActions(); }
    }
  };
  element<HTMLFormElement>('.ask-ai-form').addEventListener('submit', (event) => { event.preventDefault(); if (!send.disabled) void perform(false); });
  prompt.addEventListener('input', updateActions);
  choice.addEventListener('change', () => {
    const preview = element<HTMLDetailsElement>('.ask-ai-context-preview');
    const value = choice.value === 'selection' ? options.context.selection : choice.value === 'document' ? options.context.document : '';
    preview.hidden = !value;
    element<HTMLElement>('.ask-ai-context-preview pre').textContent = value;
  });
  stop.addEventListener('click', cancel);
  login.addEventListener('click', () => void perform(true));
  recheck.addEventListener('click', () => void checkConnection());
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(reply.value); if (!closed) status.textContent = 'Answer copied.'; }
    catch { if (!closed) { reply.focus(); reply.select(); status.textContent = 'Press ⌘C to copy the selected answer.'; } }
  });
  draft.addEventListener('click', () => { const answer = reply.value; close(); options.openDraft(answer); });
  review.addEventListener('click', () => {
    if (options.reviewReply?.(reply.value)) close();
    else status.textContent = 'The source tab changed. Copy the answer or open it as a new draft.';
  });
  clear.addEventListener('click', () => { prompt.value = ''; reply.value = ''; status.textContent = ''; lastPrompt = ''; lastReply = ''; updateActions(); prompt.focus(); });
  const studio = element<HTMLButtonElement>('.ask-ai-studio');
  studio.hidden = !options.openPromptStudio;
  studio.addEventListener('click', () => { close(); options.openPromptStudio?.(); });
  element<HTMLButtonElement>('.ask-ai-close').addEventListener('click', close);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.addEventListener('close', close);
  dialog.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !send.disabled) { event.preventDefault(); void perform(false); }
  });
  document.body.append(dialog);
  try { dialog.showModal(); prompt.focus(); }
  catch { close(); return; }
  updateActions();
  await checkConnection();
}
