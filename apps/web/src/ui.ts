// Tiny DOM helpers: no framework.

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown> & { class?: string; style?: string };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;

export function mount(root: HTMLElement, ...nodes: Node[]): void {
  root.replaceChildren(...nodes);
}

export function toast(text: string, kind: 'info' | 'bad' | 'good' = 'info'): void {
  const box = $('#toasts');
  const t = h('div', { class: `toast ${kind}` }, text);
  box.append(t);
  setTimeout(() => t.classList.add('out'), 2600);
  setTimeout(() => t.remove(), 3100);
}

export const fmtTime = (ticks: number): string => {
  const s = Math.max(0, Math.ceil(ticks / 20));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// ---------- modal dialogs (welcome cards, How to play) ----------

export const modalOpen = (): boolean => !!document.querySelector('.modal');

/**
 * Open a dialog over everything. Esc closes it; Tab stays inside; the game ignores keys while it's open.
 * Returns a close function.
 */
export function openModal(card: HTMLElement, opts: { label: string; onClose?: () => void; wide?: boolean }): () => void {
  document.querySelector('.modal')?.remove();
  const back = document.activeElement as HTMLElement | null;
  card.classList.add('modal-card');
  if (opts.wide) card.classList.add('wide');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-label', opts.label);
  const overlay = h('div', { class: 'modal' }, card);
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    overlay.remove();
    removeEventListener('keydown', onKey, true);
    if (back && document.contains(back) && back.tagName === 'INPUT') back.focus(); else (document.activeElement as HTMLElement | null)?.blur();
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (!document.contains(overlay)) { removeEventListener('keydown', onKey, true); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    const f = [...card.querySelectorAll<HTMLElement>('button, a[href], input')];
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (!card.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  addEventListener('keydown', onKey, true);
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });
  document.body.append(overlay);
  requestAnimationFrame(() => (card.querySelector<HTMLElement>('[data-autofocus]') ?? card.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true }));
  return close;
}

/** localStorage that never throws (private mode, blocked storage). */
export const saved = {
  get: (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* not remembered this time */ } },
  del: (k: string): void => { try { localStorage.removeItem(k); } catch { /* */ } },
};
