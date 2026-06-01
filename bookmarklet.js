// superclaude — claude.ai conversation branch visualizer (bookmarklet)
// Runs in the claude.ai page context. See README for build/install instructions.
(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Layer 1: Bootstrap
  //
  // Responsibilities:
  //   1. Guard: only run on claude.ai, only on a /chat/<uuid> page.
  //   2. Re-entry guard: if the user clicks the bookmark again, no-op rather
  //      than double-initializing.
  //   3. Provide a minimal toast so we can give feedback before the Shadow-DOM
  //      modal (layer 5) exists.
  //   4. Stash useful values (conv uuid, version) on a single window namespace
  //      so later layers and DevTools probes can find them.
  // ---------------------------------------------------------------------------

  const NS = '__superclaude__';
  const VERSION = '0.1.0';
  const CONV_UUID_RE = /^\/chat\/([0-9a-f-]{36})(?:\/|$)/i;

  // Re-entry guard. If the modal is already mounted, future layers will set
  // `modalOpen` so we can focus it instead of re-bootstrapping.
  if (window[NS]?.modalOpen) {
    return;
  }
  window[NS] = window[NS] || {};

  // -------------------------------------------------------------------------
  // Toast — transient pre-modal feedback. Uses `all: initial` to escape the
  // host page's CSS, max z-index to sit above Claude's UI. Click to dismiss.
  // -------------------------------------------------------------------------
  // Toast palette uses Claude tokens: dark elevated surface + a colored
  // left border indicating kind (clay = info matches the brand; red/green
  // for error/success).
  const TOAST_PALETTE = {
    info:    { accent: 'hsl(14.8 63.1% 59.6%)' },  // --accent-brand (clay)
    error:   { accent: 'hsl(0 73% 59%)' },         // --danger-100
    success: { accent: 'hsl(81 80% 50%)' },        // --success
  };

  const toast = (message, { kind = 'info', timeoutMs = 4000 } = {}) => {
    const palette = TOAST_PALETTE[kind] || TOAST_PALETTE.info;
    const el = document.createElement('div');
    el.textContent = message;
    el.style.cssText = `
      all: initial;
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      max-width: 420px;
      padding: 11px 16px 11px 14px;
      background: hsl(60 2% 17%);
      color: hsl(60 14% 97%);
      font: 400 13px/1.45 "Anthropic Sans", system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      border: 1px solid hsl(53 12% 87% / 0.10);
      border-left: 3px solid ${palette.accent};
      border-radius: 8px;
      box-shadow: 0 10px 30px -8px rgb(0 0 0 / 0.55), 0 4px 8px -4px rgb(0 0 0 / 0.4);
      z-index: 2147483647;
      cursor: pointer;
    `;
    el.addEventListener('click', () => el.remove());
    document.body.appendChild(el);
    setTimeout(() => { if (el.isConnected) el.remove(); }, timeoutMs);
  };

  // -------------------------------------------------------------------------
  // URL guards. Fail loudly with a toast so the user knows why nothing opened.
  // -------------------------------------------------------------------------
  if (location.hostname !== 'claude.ai') {
    toast('Open claude.ai first, then click the bookmark.', { kind: 'error' });
    return;
  }

  const match = location.pathname.match(CONV_UUID_RE);
  if (!match) {
    toast('Open a Claude.ai conversation first (URL should be /chat/<id>).', { kind: 'error' });
    return;
  }

  const convUuid = match[1].toLowerCase();

  // -------------------------------------------------------------------------
  // Stash boot info for later layers. Expose the toast so subsequent layers
  // (and DevTools) can reuse it without redefining.
  // -------------------------------------------------------------------------
  window[NS].version = VERSION;
  window[NS].convUuid = convUuid;
  window[NS].toast = toast;

  // ---------------------------------------------------------------------------
  // Layer 2: API client
  //
  // Pure-ish wrappers around the Claude.ai HTTP API. Each call returns either
  // parsed JSON or (for SSE endpoints) the raw Response. Errors are normalized
  // to ApiError with a `code` field so callers can dispatch by category instead
  // of inspecting status/text everywhere.
  //
  // Same-origin fetches automatically include sessionKey + cf_clearance cookies.
  // ---------------------------------------------------------------------------

  const API_BASE = '/api';

  class ApiError extends Error {
    constructor({ code, status, body, message }) {
      super(message);
      this.name = 'ApiError';
      this.code = code;     // 'unauthenticated' | 'cloudflare' | 'http' | 'network' | 'parse'
      this.status = status;
      this.body = body;
    }
  }

  // Detect a Cloudflare interstitial / managed-challenge response.
  //   1. `cf-mitigated: challenge` — canonical "Cloudflare blocked this" header.
  //      Strongest signal; on its own sufficient.
  //   2. cf-ray + HTML content-type + interstitial title — fallback for cases
  //      where (1) is absent. cf-ray alone is *not* enough because every
  //      Cloudflare-served response carries it (including successful API calls).
  const isCloudflareChallenge = (resp, text) => {
    if (resp.headers.get('cf-mitigated') === 'challenge') return true;
    const contentType = resp.headers.get('content-type') || '';
    return contentType.startsWith('text/html')
      && resp.headers.get('cf-ray') != null
      && typeof text === 'string'
      && text.includes('<title>Just a moment...</title>');
  };

  const apiFetch = async (path, { method = 'GET', body, accept = 'application/json' } = {}) => {
    let resp;
    try {
      resp = await fetch(API_BASE + path, {
        method,
        headers: {
          'accept': accept,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
      });
    } catch (err) {
      throw new ApiError({ code: 'network', message: `network error: ${err.message}` });
    }

    if (!resp.ok) {
      // Read body once and reuse for cloudflare detection + error reporting.
      // Cloudflare challenges can surface as 403 / 429 / 503 / 520; checking
      // only on 403 would miss the rest, so we check on any non-OK status.
      let text = null;
      try { text = await resp.text(); } catch {}

      if (isCloudflareChallenge(resp, text)) {
        throw new ApiError({
          code: 'cloudflare', status: resp.status, body: text,
          message: 'Cloudflare challenge active — solve it on the main tab, then retry',
        });
      }

      if (resp.status === 401) {
        throw new ApiError({ code: 'unauthenticated', status: 401, message: 'Not logged in to Claude.ai' });
      }

      let parsed = text;
      if (text) { try { parsed = JSON.parse(text); } catch {} }
      const apiMsg = parsed && typeof parsed === 'object' ? parsed.error?.message : null;
      throw new ApiError({
        code: 'http', status: resp.status, body: parsed,
        message: `HTTP ${resp.status}${apiMsg ? `: ${apiMsg}` : ''}`,
      });
    }

    // SSE: hand the Response back; the caller streams it.
    if (accept === 'text/event-stream') return resp;

    try {
      return await resp.json();
    } catch (err) {
      throw new ApiError({ code: 'parse', status: resp.status, message: `failed to parse JSON: ${err.message}` });
    }
  };

  // ---- Endpoint wrappers --------------------------------------------------

  const listOrgs = () =>
    apiFetch('/organizations');

  const listConversations = (orgUuid, { limit = 30, starred = false } = {}) =>
    apiFetch(`/organizations/${orgUuid}/chat_conversations_v2?limit=${limit}&starred=${starred}&consistency=eventual`);

  const getConversation = (orgUuid, conv) =>
    apiFetch(`/organizations/${orgUuid}/chat_conversations/${conv}?tree=true&rendering_mode=messages&render_all_tools=true&consistency=eventual`);

  const setCurrentLeaf = (orgUuid, conv, leafUuid) =>
    apiFetch(`/organizations/${orgUuid}/chat_conversations/${conv}/current_leaf_message_uuid`, {
      method: 'PUT',
      body: { current_leaf_message_uuid: leafUuid },
    });

  const completion = (orgUuid, conv, body) =>
    apiFetch(`/organizations/${orgUuid}/chat_conversations/${conv}/completion`, {
      method: 'POST',
      body,
      accept: 'text/event-stream',
    });

  const retryCompletion = (orgUuid, conv, body) =>
    apiFetch(`/organizations/${orgUuid}/chat_conversations/${conv}/retry_completion`, {
      method: 'POST',
      body,
      accept: 'text/event-stream',
    });

  // Convenience: pick the chat-capable org from a `listOrgs()` response.
  // Org membership can include `api`-only workspaces (e.g. team orgs) that 404
  // on `chat_conversations/*`, so filtering on capabilities is essential.
  const pickChatOrg = (orgs) =>
    (Array.isArray(orgs) ? orgs : []).find(o => Array.isArray(o.capabilities) && o.capabilities.includes('chat')) || null;

  window[NS].api = {
    listOrgs, listConversations, getConversation,
    setCurrentLeaf, completion, retryCompletion,
    pickChatOrg, ApiError,
  };

  // ---------------------------------------------------------------------------
  // Layer 3: State store
  //
  // Single source of truth for app state. Tiny pub-sub: getState/setState/
  // subscribe. State is frozen on every write so callers can't mutate it by
  // accident — the only way to change anything is to call setState.
  //
  // Shape:
  //   conv          full conversation object from getConversation (or null)
  //   org           chat-capable org object (or null)
  //   selected      uuid of the message currently highlighted in the UI
  //   query         active search string (regex source)
  //   showOnlyPath  collapse off-path branches in the tree view
  //   isLoading     true while a fetch is in flight
  //   error         last ApiError that surfaced (or null)
  // ---------------------------------------------------------------------------

  const createStore = (initial) => {
    let state = Object.freeze({ ...initial });
    const listeners = new Set();
    return {
      getState: () => state,
      setState: (patch) => {
        const delta = typeof patch === 'function' ? patch(state) : patch;
        if (!delta) return state;
        // Skip notify if every key in the patch already matches current state.
        // Saves a full rerender (and listener cascade) on no-op updates.
        let changed = false;
        for (const k of Object.keys(delta)) {
          if (!Object.is(state[k], delta[k])) { changed = true; break; }
        }
        if (!changed) return state;
        state = Object.freeze({ ...state, ...delta });
        for (const fn of listeners) {
          try { fn(state); } catch (err) { console.error('[superclaude] subscriber error:', err); }
        }
        return state;
      },
      subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
  };

  const store = createStore({
    conv: null,
    org: null,
    selected: null,
    query: '',
    showOnlyPath: false,
    zoom: 1,
    isLoading: false,
    error: null,
  });

  const MIN_ZOOM = 0.3;
  const MAX_ZOOM = 3;
  const ZOOM_FACTOR = 1.25;
  const clampZoom = (z) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));

  window[NS].store = store;

  // ---------------------------------------------------------------------------
  // Layer 4: Tree model
  //
  // Pure functions over the conversation's `chat_messages` array. No store
  // dependency — callers pass messages (or a pre-built index) in. Reused by
  // layer 5 (rendering) and layer 6 (actions like "jump to latest").
  //
  // Tree shape:
  //   Each message has a unique `uuid` and exactly one `parent_message_uuid`.
  //   Root messages point at the all-zeros sentinel (or, on older convs, null).
  //   Branches are siblings: multiple messages sharing the same parent.
  // ---------------------------------------------------------------------------

  const ROOT_SENTINEL = '00000000-0000-4000-8000-000000000000';
  const isRoot = (uuid) => !uuid || uuid === ROOT_SENTINEL;

  // Build O(1) lookup structures. Children sorted oldest-first so that the
  // "first sibling" at a branch point matches what the Claude.ai UI shows.
  const buildIndex = (messages) => {
    const byUuid = new Map();
    const childrenOf = new Map();
    for (const m of messages) {
      byUuid.set(m.uuid, m);
      const parent = m.parent_message_uuid;
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      childrenOf.get(parent).push(m);
    }
    for (const arr of childrenOf.values()) {
      arr.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    }
    return { byUuid, childrenOf };
  };

  // Walk parent pointers from a leaf up to the root; return root → leaf order.
  // Stops at the root sentinel or when a parent uuid isn't found in the index
  // (defensive against partial trees, though we don't expect that in practice).
  const walkToRoot = (leafUuid, index) => {
    const path = [];
    let cur = index.byUuid.get(leafUuid);
    const seen = new Set();
    while (cur && !seen.has(cur.uuid)) {
      seen.add(cur.uuid);
      path.unshift(cur);
      if (isRoot(cur.parent_message_uuid)) break;
      cur = index.byUuid.get(cur.parent_message_uuid);
    }
    return path;
  };

  // Message with the max created_at across the whole conversation.
  const findLatestByTimestamp = (messages) =>
    messages.length
      ? messages.reduce((a, b) => (new Date(b.created_at) > new Date(a.created_at) ? b : a))
      : null;

  // All forks in the tree: parents with more than one child. Returned as
  // [{ parentUuid, children: [...sorted oldest-first] }].
  const findBranchPoints = (index) => {
    const points = [];
    for (const [parentUuid, kids] of index.childrenOf) {
      if (kids.length > 1) points.push({ parentUuid, children: kids });
    }
    return points;
  };

  // Leaf messages — no children. Used by cross-branch discovery features.
  const findLeaves = (messages, index) =>
    messages.filter(m => !index.childrenOf.has(m.uuid));

  // Sibling messages (other children of the same parent). Excludes self.
  const siblingsOf = (uuid, index) => {
    const msg = index.byUuid.get(uuid);
    if (!msg) return [];
    return (index.childrenOf.get(msg.parent_message_uuid) || []).filter(s => s.uuid !== uuid);
  };

  // All descendants of `uuid` (depth-first, including `uuid` itself).
  const descendantsOf = (uuid, index) => {
    const result = [];
    const stack = [uuid];
    while (stack.length) {
      const u = stack.pop();
      const m = index.byUuid.get(u);
      if (!m) continue;
      result.push(m);
      const kids = index.childrenOf.get(u) || [];
      // Push reversed so DFS visits in chronological order.
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i].uuid);
    }
    return result;
  };

  // Flatten a message's content for search/preview. With
  // rendering_mode=messages the canonical body lives in `content[]` blocks;
  // the top-level `text` field is usually empty but kept as a fallback for
  // older convs and raw-mode payloads.
  const extractText = (msg, { includeThinking = true, includeAttachments = false } = {}) => {
    const parts = [];
    if (Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (c.type === 'text' && c.text) parts.push(c.text);
        else if (c.type === 'thinking' && includeThinking && c.thinking) parts.push(c.thinking);
        else if (c.type === 'tool_use' && c.name) parts.push(`[tool: ${c.name}]`);
        else if (c.type === 'tool_result' && typeof c.content === 'string') parts.push(c.content);
      }
    }
    if (!parts.length && typeof msg.text === 'string' && msg.text) parts.push(msg.text);
    if (includeAttachments && Array.isArray(msg.attachments)) {
      for (const a of msg.attachments) {
        if (a.extracted_content) parts.push(a.extracted_content);
      }
    }
    return parts.join('\n').trim();
  };

  // Short label for tree nodes — first line of body text, trimmed to n chars.
  const snippet = (msg, n = 80) => {
    const t = extractText(msg, { includeThinking: false }).replace(/\s+/g, ' ');
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  };

  // Case-insensitive regex search over message bodies (incl. attachments).
  // Returns matches in original tree order. Bad regex → empty array.
  const searchMessages = (messages, query) => {
    if (!query) return [];
    let re;
    try { re = new RegExp(query, 'i'); }
    catch { return []; }
    return messages.filter(m => re.test(extractText(m, { includeAttachments: true })));
  };

  window[NS].tree = {
    ROOT_SENTINEL, isRoot,
    buildIndex, walkToRoot,
    findLatestByTimestamp, findBranchPoints, findLeaves,
    siblingsOf, descendantsOf,
    extractText, snippet, searchMessages,
  };

  // ---------------------------------------------------------------------------
  // Layer 5: UI
  //
  // Shadow-DOM modal with three regions:
  //   • Header  — conversation title + close button
  //   • Toolbar — search input, "Jump to latest", "Show only path" toggle
  //   • Content — left: SVG tree of the whole conversation; right: preview
  //               pane for the selected message + "Jump to this branch" action
  //
  // Render strategy: full re-render on every store change. Simple and
  // correct; 700-node SVGs are well within browser capacity. We re-wire
  // delegated event listeners on every render (innerHTML wipes them).
  // ---------------------------------------------------------------------------

  const HOST_ID = '__superclaude_host__';

  // Styles use Claude.ai's design tokens (sampled from --bg-*, --text-*,
  // --accent-brand, --font-anthropic-sans on claude.ai itself) so the modal
  // visually belongs to the page it overlays. Tokens are declared on :host
  // so every selector can reference them by name; raw hsl() values only
  // appear at the token definitions.
  const STYLES = `
    :host {
      all: initial;

      /* Surfaces (dark) — layered from elevated (modal) to deep (sunken panes). */
      --bv-bg-modal:   hsl(60 2% 17%);   /* --bg-000 — modal card */
      --bv-bg-sunk:    hsl(60 2% 9%);    /* --bg-200 — tree pane, inputs */
      --bv-bg-hover:   hsl(53 12% 87% / 0.06);
      --bv-bg-active:  hsl(53 12% 87% / 0.10);

      /* Text hierarchy. */
      --bv-text:       hsl(60 14% 97%);  /* --text-000 */
      --bv-text-2:     hsl(55 9% 74%);   /* --text-200 */
      --bv-text-3:     hsl(48 5% 57%);   /* --text-400 */

      /* Borders — Claude's border token is a light cream applied at low
         alpha in dark mode; the three steps map to separator / interactive
         / strong-interactive. */
      --bv-border:     hsl(53 12% 87% / 0.10);
      --bv-border-2:   hsl(53 12% 87% / 0.16);
      --bv-border-3:   hsl(53 12% 87% / 0.24);

      /* Accents. */
      --bv-clay:       hsl(14.8 63.1% 59.6%);   /* --accent-brand */
      --bv-clay-emph:  hsl(15.1 54.2% 51.2%);
      --bv-focus:      hsl(212 75% 62%);        /* --accent-100 */
      --bv-success:    hsl(83 54% 61%);         /* --success-000 */
      --bv-warn:       hsl(40 92% 65%);

      /* Typography — Anthropic Sans is loaded by claude.ai; fall back to
         the same system stack Claude declares. */
      --bv-font: "Anthropic Sans", system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      --bv-mono: "Anthropic Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      --bv-serif: "Anthropic Serif", Georgia, "Times New Roman", serif;

      --bv-radius:    12px;
      --bv-radius-sm: 6px;
      --bv-shadow:    0 24px 64px -16px rgb(0 0 0 / 0.65), 0 8px 16px -8px rgb(0 0 0 / 0.45);
      --bv-ease:      cubic-bezier(0, 0, .2, 1);
    }
    *, *::before, *::after { box-sizing: border-box; }

    .backdrop {
      position: fixed; inset: 0;
      background: rgb(0 0 0 / 0.55);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
    }

    /* Modal: centered, constrained card. inset + auto margins give a
       symmetric viewport gutter and cap the maximum size so the layout
       stays balanced on ultra-wide monitors. */
    .modal {
      position: fixed;
      inset: 4vh 4vw;
      margin: auto;
      max-width: 1200px;
      max-height: 920px;
      background: var(--bv-bg-modal);
      color: var(--bv-text);
      border: 1px solid var(--bv-border);
      border-radius: var(--bv-radius);
      box-shadow: var(--bv-shadow);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      font-family: var(--bv-font);
      font-size: 14px;
      line-height: 1.5;
    }

    /* Header */
    header {
      padding: 14px 18px;
      border-bottom: 1px solid var(--bv-border);
      display: flex;
      align-items: center;
      gap: 12px;
      flex-shrink: 0;
    }
    header h1 {
      margin: 0;
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: baseline;
      gap: 10px;
      font-size: 15px;
      font-weight: 500;
      letter-spacing: -0.005em;
    }
    header h1 .title {
      color: var(--bv-text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    header h1 .sub {
      color: var(--bv-text-3);
      font-size: 12px;
      font-weight: 400;
      letter-spacing: 0;
      flex-shrink: 0;
      font-variant-numeric: tabular-nums;
    }
    header h1 .sub .warn { color: var(--bv-warn); }
    .close-btn {
      width: 28px; height: 28px;
      border-radius: var(--bv-radius-sm);
      background: transparent;
      border: 1px solid var(--bv-border-2);
      color: var(--bv-text-2);
      cursor: pointer;
      font-size: 17px;
      line-height: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      transition: background-color 120ms var(--bv-ease), color 120ms var(--bv-ease);
    }
    .close-btn:hover { background: var(--bv-bg-hover); color: var(--bv-text); }
    .close-btn:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--bv-focus); }

    /* Toolbar */
    .toolbar {
      padding: 10px 18px;
      border-bottom: 1px solid var(--bv-border);
      display: flex;
      gap: 10px;
      align-items: center;
      flex-shrink: 0;
    }
    .search {
      flex: 1;
      padding: 8px 12px;
      background: var(--bv-bg-sunk);
      border: 1px solid var(--bv-border-2);
      border-radius: var(--bv-radius-sm);
      color: var(--bv-text);
      font: 400 13px/1.5 var(--bv-font);
      outline: none;
      transition: border-color 120ms var(--bv-ease), box-shadow 120ms var(--bv-ease);
    }
    .search::placeholder { color: var(--bv-text-3); }
    .search:focus {
      border-color: var(--bv-focus);
      box-shadow: 0 0 0 1px var(--bv-focus);
    }
    .toolbar button {
      padding: 7px 12px;
      background: transparent;
      border: 1px solid var(--bv-border-2);
      border-radius: var(--bv-radius-sm);
      color: var(--bv-text);
      font: 500 13px/1.4 var(--bv-font);
      cursor: pointer;
      transition: background-color 120ms var(--bv-ease), border-color 120ms var(--bv-ease);
    }
    .toolbar button:hover:not(:disabled) { background: var(--bv-bg-hover); }
    .toolbar button:disabled { opacity: 0.4; cursor: not-allowed; }
    .toolbar button:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--bv-focus); }
    .toolbar label {
      font-size: 12px;
      color: var(--bv-text-2);
      cursor: pointer;
      user-select: none;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .toolbar input[type="checkbox"] { accent-color: var(--bv-clay); cursor: pointer; }

    .match-count {
      color: var(--bv-text-3);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      flex-shrink: 0;
      padding: 0 2px;
    }

    .zoom-group {
      display: flex;
      gap: 2px;
      align-items: center;
      border: 1px solid var(--bv-border-2);
      border-radius: var(--bv-radius-sm);
      padding: 2px;
    }
    .zoom-group button {
      padding: 4px 8px;
      border-radius: 4px;
      border: none;
      background: transparent;
      min-width: 26px;
      color: var(--bv-text-2);
      font: 500 13px/1.4 var(--bv-font);
      cursor: pointer;
      transition: background-color 100ms var(--bv-ease), color 100ms var(--bv-ease);
    }
    .zoom-group button:hover:not(:disabled) { background: var(--bv-bg-hover); color: var(--bv-text); }
    .zoom-group button:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--bv-focus); }
    .zoom-group .level {
      color: var(--bv-text-3);
      font-size: 11px;
      padding: 0 6px;
      min-width: 42px;
      text-align: center;
      font-variant-numeric: tabular-nums;
    }

    /* Content panes */
    .content { flex: 1; display: flex; min-height: 0; }

    .tree-pane {
      flex: 1.6;
      overflow: auto;
      background: var(--bv-bg-sunk);
      padding: 20px;
      min-width: 0;
    }

    .preview-pane {
      flex: 1;
      overflow: auto;
      padding: 20px 22px;
      border-left: 1px solid var(--bv-border);
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .preview-pane .role {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--bv-focus);
    }
    .preview-pane .role.assistant { color: var(--bv-clay); }
    .preview-pane .meta {
      color: var(--bv-text-3);
      font-size: 11px;
      font-family: var(--bv-mono);
      margin: 4px 0 16px;
    }
    .preview-pane .body {
      line-height: 1.6;
      font-size: 14px;
      word-break: break-word;
      font-family: var(--bv-serif);   /* Claude's assistant response font */
      color: var(--bv-text);
      flex: 1;
    }
    .preview-pane .body.human {
      font-family: var(--bv-font);    /* Claude's user message font (sans) */
    }

    /* Markdown blocks. pre-wrap on <p>/<blockquote> only so internal
       newlines render as soft breaks; the renderer's own block layout
       handles paragraph spacing. */
    .preview-pane .body > *:first-child { margin-top: 0; }
    .preview-pane .body > *:last-child  { margin-bottom: 0; }
    .preview-pane .body p,
    .preview-pane .body blockquote { white-space: pre-wrap; }
    .preview-pane .body p { margin: 0 0 12px; }
    .preview-pane .body h1,
    .preview-pane .body h2,
    .preview-pane .body h3,
    .preview-pane .body h4,
    .preview-pane .body h5,
    .preview-pane .body h6 {
      font-family: inherit;
      margin: 18px 0 8px;
      font-weight: 600;
      letter-spacing: -0.005em;
      color: var(--bv-text);
      line-height: 1.35;
    }
    .preview-pane .body h1 { font-size: 18px; }
    .preview-pane .body h2 { font-size: 16px; }
    .preview-pane .body h3 { font-size: 15px; }
    .preview-pane .body h4 { font-size: 14px; }
    .preview-pane .body h5,
    .preview-pane .body h6 { font-size: 13px; color: var(--bv-text-2); }
    .preview-pane .body strong { font-weight: 600; color: var(--bv-text); }
    .preview-pane .body em { font-style: italic; }
    .preview-pane .body a {
      color: var(--bv-clay);
      text-decoration: none;
      border-bottom: 1px solid hsl(14.8 63.1% 59.6% / 0.35);
    }
    .preview-pane .body a:hover { border-bottom-color: var(--bv-clay); }
    .preview-pane .body code {
      font-family: var(--bv-mono);
      font-size: 0.88em;
      background: var(--bv-bg-sunk);
      padding: 1px 5px;
      border-radius: 4px;
      border: 1px solid var(--bv-border);
    }
    .preview-pane .body pre {
      background: var(--bv-bg-sunk);
      border: 1px solid var(--bv-border);
      border-radius: 8px;
      padding: 12px 14px;
      margin: 12px 0;
      overflow-x: auto;
      font-size: 12px;
      line-height: 1.5;
    }
    .preview-pane .body pre code {
      background: none;
      border: 0;
      padding: 0;
      font-size: inherit;
      color: var(--bv-text);
    }
    .preview-pane .body ul,
    .preview-pane .body ol { margin: 8px 0 12px; padding-left: 24px; }
    .preview-pane .body li { margin: 3px 0; }
    .preview-pane .body li::marker { color: var(--bv-text-3); }
    .preview-pane .body blockquote {
      margin: 12px 0;
      padding: 4px 0 4px 14px;
      border-left: 3px solid var(--bv-border-3);
      color: var(--bv-text-2);
    }
    .preview-pane .body hr {
      border: 0;
      border-top: 1px solid var(--bv-border);
      margin: 18px 0;
    }
    .preview-pane .body .empty-body {
      color: var(--bv-text-3);
      font-style: italic;
    }
    .preview-pane .actions {
      margin-top: 20px;
      padding-top: 16px;
      border-top: 1px solid var(--bv-border);
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      flex-shrink: 0;
    }

    .jump-btn {
      padding: 8px 16px;
      background: var(--bv-clay);
      color: hsl(0 0% 100%);
      border: 1px solid var(--bv-clay);
      border-radius: var(--bv-radius-sm);
      cursor: pointer;
      font: 500 13px/1.4 var(--bv-font);
      transition: background-color 120ms var(--bv-ease), border-color 120ms var(--bv-ease);
    }
    .jump-btn:hover:not(:disabled) {
      background: var(--bv-clay-emph);
      border-color: var(--bv-clay-emph);
    }
    .jump-btn:disabled {
      background: transparent;
      color: var(--bv-text-3);
      border-color: var(--bv-border-2);
      cursor: not-allowed;
    }
    .jump-btn:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--bv-focus); }

    /* Empty / loading states — vertically + horizontally centered inside
       their pane via auto margins in a flex column. .tree-pane isn't a
       flex container, so we fall back to mx-auto + top padding there. */
    .empty {
      padding: 32px 24px;
      text-align: center;
      color: var(--bv-text-3);
      font-size: 13px;
      margin: auto;
      max-width: 320px;
    }
    .tree-pane > .empty { margin: 80px auto 0; }
    .empty .muted { color: var(--bv-text-3); display: block; margin-top: 6px; font-size: 12px; }
    .empty.loading { animation: bv-pulse 1.4s var(--bv-ease) infinite; }
    @keyframes bv-pulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }

    /* SVG tree — centered horizontally when it fits, scrolls to the left
       edge when it overflows (auto margins collapse to 0 in that case). */
    svg.tree { display: block; margin: 0 auto; }

    .node rect {
      fill: var(--bv-bg-modal);
      stroke: var(--bv-border-2);
      stroke-width: 1;
      cursor: pointer;
      transition: filter 100ms var(--bv-ease);
    }
    /* Subtle tint per role — borrowed from Claude's blue (user) and clay
       (brand/assistant) palettes, blended dark to read as muted backgrounds
       rather than colored bubbles. */
    .node.human rect     { fill: hsl(212 30% 16%); }
    .node.assistant rect { fill: hsl(15 30% 16%); }
    .node.on-path rect   { stroke: var(--bv-focus); stroke-width: 1.5; }
    .node.latest rect    { stroke: var(--bv-success); stroke-width: 1.5; }
    .node.selected rect  { stroke: var(--bv-clay); stroke-width: 2; }
    .node:hover rect     { filter: brightness(1.35); }
    .node text {
      fill: var(--bv-text);
      font-size: 11px;
      font-family: var(--bv-font);
      pointer-events: none;
      user-select: none;
    }
    .node.muted { opacity: 0.22; }

    /* Current-leaf marker: a small clay dot in the node's upper-right
       corner. Distinct from .selected (which is user-driven) so the
       "you are here" indicator survives even when the user clicks
       elsewhere in the tree. */
    .leaf-dot { fill: var(--bv-clay); }

    .edge { stroke: var(--bv-border-3); stroke-width: 1; fill: none; }
    .edge.on-path { stroke: var(--bv-focus); stroke-width: 1.5; }

    /* Scrollbars — slim, low-contrast, hover-emphasized. WebKit only;
       Firefox falls back to its own narrow scrollbar. */
    *::-webkit-scrollbar { width: 10px; height: 10px; }
    *::-webkit-scrollbar-track { background: transparent; }
    *::-webkit-scrollbar-thumb {
      background-color: hsl(53 12% 87% / 0.10);
      border-radius: 5px;
      border: 2px solid transparent;
      background-clip: padding-box;
    }
    *::-webkit-scrollbar-thumb:hover {
      background-color: hsl(53 12% 87% / 0.20);
      background-clip: padding-box;
      border: 2px solid transparent;
    }
  `;

  // Cache the message index by conversation reference. The same conv flows
  // through renderTreeSvg → renderPreview → render() on every store update,
  // and buildIndex is a pure function of conv.chat_messages, so we rebuild
  // only when the conv object identity actually changes.
  let _indexCache = { conv: null, index: null };
  const getIndex = (conv) => {
    if (_indexCache.conv !== conv) {
      _indexCache = { conv, index: window[NS].tree.buildIndex(conv.chat_messages) };
    }
    return _indexCache.index;
  };

  // Layout: assign (x, y) to each node by leaf-counting. Subtree footprint
  // = number of leaf descendants; node is centered over its footprint. Cheap
  // and produces a clean tidy layout.
  const layoutTree = (roots, index) => {
    const positions = new Map();
    let maxDepth = 0;
    const visit = (uuid, depth, xOffset) => {
      if (depth > maxDepth) maxDepth = depth;
      const kids = index.childrenOf.get(uuid) || [];
      if (!kids.length) {
        positions.set(uuid, { x: xOffset + 0.5, y: depth });
        return 1;
      }
      let acc = xOffset, total = 0;
      for (const k of kids) {
        const leaves = visit(k.uuid, depth + 1, acc);
        acc += leaves;
        total += leaves;
      }
      positions.set(uuid, { x: xOffset + total / 2, y: depth });
      return total;
    };
    let acc = 0, totalLeaves = 0;
    for (const r of roots) {
      const leaves = visit(r.uuid, 0, acc);
      acc += leaves;
      totalLeaves += leaves;
    }
    return { positions, totalLeaves, maxDepth };
  };

  const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  // Minimal markdown renderer. Bundling a real library (marked ~30 KB,
  // markdown-it ~50 KB) would blow the bookmarklet URL budget, so we
  // hand-roll coverage for the syntax Claude actually emits in chat:
  // headings, bold/italic, inline + fenced code, links, ordered/unordered
  // lists, blockquotes, horizontal rules, paragraphs.
  //
  // Safety: all input is HTML-escaped first; the only tags reintroduced
  // come from a fixed allow-list inside this function. Link hrefs are
  // gated to http/https/mailto so a [text](javascript:...) can't escape.
  // Trade-offs we accept: no nested lists, no tables, no autolinks, no
  // triple-emphasis (***bold-italic***), no setext headings.
  const renderMarkdown = (src) => {
    if (!src) return '';

    const inline = (text) => {
      let s = escapeHtml(text);
      // Inline code first — extracted to placeholders so * / _ inside
      // backticks don't get re-interpreted as emphasis below.
      const codes = [];
      s = s.replace(/`([^`]+)`/g, (_, c) => {
        codes.push(c);   // already HTML-escaped above; do not re-escape
        return `\x00${codes.length - 1}\x00`;
      });
      // Emphasis: bold before italic so ** isn't eaten by single-*.
      s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/__(.+?)__/g,     '<strong>$1</strong>');
      s = s.replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
      s = s.replace(/(^|[\s(])_(?!\s)([^_\n]+?)_(?=[\s).,!?:;]|$)/g,   '$1<em>$2</em>');
      // Links: [text](href). Reject anything that isn't http(s) or mailto.
      s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, url) => {
        const safe = /^(https?:|mailto:)/i.test(url);
        return safe
          ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${t}</a>`
          : t;
      });
      // Restore inline code with proper tags.
      s = s.replace(/\x00(\d+)\x00/g, (_, i) => `<code>${codes[+i]}</code>`);
      return s;
    };

    const lines = src.split('\n');
    const out = [];
    let i = 0;

    // Regex for "this line starts a block other than a paragraph" — used
    // to terminate paragraph collection.
    const BLOCK_START = /^(```|#{1,6}\s|>|[-*+]\s|\d+\.\s|---+\s*$|\*\*\*+\s*$|___+\s*$)/;

    while (i < lines.length) {
      const line = lines[i];

      // Fenced code block.
      if (/^```/.test(line)) {
        const lang = line.slice(3).trim();
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++; // closing fence (or EOF)
        const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
        out.push(`<pre><code${langAttr}>${escapeHtml(buf.join('\n'))}</code></pre>`);
        continue;
      }

      // ATX heading.
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const lvl = h[1].length;
        out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
        i++; continue;
      }

      // Horizontal rule.
      if (/^(---+|\*\*\*+|___+)\s*$/.test(line)) {
        out.push('<hr>');
        i++; continue;
      }

      // Blockquote.
      if (/^>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^>\s?/, ''));
          i++;
        }
        out.push(`<blockquote>${inline(buf.join('\n'))}</blockquote>`);
        continue;
      }

      // Unordered list.
      if (/^[-*+]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^[-*+]\s+/, ''));
          i++;
        }
        out.push(`<ul>${items.map(t => `<li>${inline(t)}</li>`).join('')}</ul>`);
        continue;
      }

      // Ordered list.
      if (/^\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\d+\.\s+/, ''));
          i++;
        }
        out.push(`<ol>${items.map(t => `<li>${inline(t)}</li>`).join('')}</ol>`);
        continue;
      }

      // Blank line — paragraph separator.
      if (line.trim() === '') { i++; continue; }

      // Paragraph — gather until blank line or next block marker.
      const buf = [line];
      i++;
      while (i < lines.length && lines[i].trim() !== '' && !BLOCK_START.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      out.push(`<p>${inline(buf.join('\n'))}</p>`);
    }

    return out.join('');
  };

  const renderTreeSvg = (state) => {
    const { conv, selected, query, showOnlyPath, zoom } = state;
    if (!conv) {
      if (state.error) {
        return `<div class="empty">Couldn't load conversation.<br><span class="muted">${escapeHtml(state.error.message)}</span></div>`;
      }
      return '<div class="empty loading">Loading conversation…</div>';
    }
    const T = window[NS].tree;
    const index = getIndex(conv);
    const path = T.walkToRoot(conv.current_leaf_message_uuid, index);
    const pathUuids = new Set(path.map(m => m.uuid));
    const latest = T.findLatestByTimestamp(conv.chat_messages);
    const matches = query
      ? new Set(T.searchMessages(conv.chat_messages, query).map(m => m.uuid))
      : null;
    const roots = (index.childrenOf.get(T.ROOT_SENTINEL) || [])
      .concat(index.childrenOf.get(null) || []);
    if (!roots.length) return '<div class="empty">No messages.</div>';

    const { positions, totalLeaves, maxDepth } = layoutTree(roots, index);
    const cellW = 190, rowH = 46, padX = 16, padY = 16;
    const nodeW = 170, nodeH = 30;
    const width  = Math.max(totalLeaves * cellW + padX * 2, 400);
    const height = (maxDepth + 1) * rowH + padY * 2 + nodeH;
    const z = clampZoom(zoom || 1);
    // viewBox keeps internal coords stable; width/height scale the rendering
    // so scrollbars in .tree-pane track the displayed size correctly.
    const parts = [`<svg class="tree" width="${width * z}" height="${height * z}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`];

    // Edges (drawn first so nodes sit on top)
    for (const msg of conv.chat_messages) {
      if (T.isRoot(msg.parent_message_uuid)) continue;
      const p = positions.get(msg.parent_message_uuid);
      const c = positions.get(msg.uuid);
      if (!p || !c) continue;
      if (showOnlyPath && !(pathUuids.has(msg.uuid) && pathUuids.has(msg.parent_message_uuid))) continue;
      const x1 = p.x * cellW + padX, y1 = p.y * rowH + padY + nodeH;
      const x2 = c.x * cellW + padX, y2 = c.y * rowH + padY;
      const onPath = pathUuids.has(msg.uuid) && pathUuids.has(msg.parent_message_uuid);
      parts.push(`<line class="edge ${onPath ? 'on-path' : ''}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`);
    }

    // Nodes
    for (const msg of conv.chat_messages) {
      const pos = positions.get(msg.uuid);
      if (!pos) continue;
      if (showOnlyPath && !pathUuids.has(msg.uuid)) continue;
      const cx = pos.x * cellW + padX, cy = pos.y * rowH + padY;
      const isCurrentLeaf = msg.uuid === conv.current_leaf_message_uuid;
      const klass = [
        'node', msg.sender,
        pathUuids.has(msg.uuid) ? 'on-path' : '',
        isCurrentLeaf ? 'current-leaf' : '',
        msg.uuid === selected ? 'selected' : '',
        latest && msg.uuid === latest.uuid ? 'latest' : '',
        matches && !matches.has(msg.uuid) ? 'muted' : '',
      ].filter(Boolean).join(' ');
      const label = T.snippet(msg, 24);
      // SVG <title> renders as a native browser tooltip on hover — free
      // "see full message text without clicking" affordance.
      const tooltip = T.snippet(msg, 240);
      parts.push(
        `<g class="${klass}" data-uuid="${msg.uuid}" transform="translate(${cx - nodeW/2},${cy})">`,
        `<title>${escapeHtml(tooltip)}</title>`,
        `<rect width="${nodeW}" height="${nodeH}" rx="4"/>`,
        `<text x="8" y="${nodeH/2 + 4}">${escapeHtml(label)}</text>`,
        isCurrentLeaf ? `<circle class="leaf-dot" cx="${nodeW - 6}" cy="6" r="3"/>` : '',
        `</g>`
      );
    }
    parts.push('</svg>');
    return parts.join('');
  };

  const renderPreview = (state) => {
    const { conv, selected } = state;
    if (!conv) return '<div class="empty"></div>';   // tree pane already shows the loading/error state
    if (!selected) return '<div class="empty">Select a node from the tree.</div>';
    const msg = getIndex(conv).byUuid.get(selected);
    if (!msg) return '<div class="empty">Message not found in tree.</div>';
    const T = window[NS].tree;
    const body = T.extractText(msg, { includeThinking: true });
    const time = new Date(msg.created_at).toLocaleString();
    const isCurrent = msg.uuid === conv.current_leaf_message_uuid;
    const isLoading = state.isLoading;
    const disabled = isCurrent || isLoading;
    const label = isLoading ? 'Switching…' : isCurrent ? 'Current branch leaf' : 'Jump to this branch';
    return `
      <div class="role ${msg.sender}">${escapeHtml(msg.sender)}</div>
      <div class="meta">${escapeHtml(time)} · ${msg.uuid.slice(0, 8)}…</div>
      <div class="body ${msg.sender}">${body ? renderMarkdown(body) : '<p class="empty-body">(no content)</p>'}</div>
      <div class="actions">
        <button class="jump-btn" data-action="jump" data-uuid="${msg.uuid}" ${disabled ? 'disabled' : ''}>${label}</button>
      </div>
    `;
  };

  // Build the static skeleton ONCE inside `.modal`. After this, the input,
  // buttons, checkbox, and pane containers persist for the lifetime of the
  // modal — `paint()` only mutates textContent / attributes / pane innerHTML.
  // The search input is never recreated, so focus and the user's in-flight
  // value survive every rerender.
  const buildSkeleton = (modal) => {
    modal.innerHTML = `
      <header>
        <h1><span class="title">superclaude</span> <span class="sub"></span></h1>
        <button class="close-btn" data-action="close" aria-label="Close">×</button>
      </header>
      <div class="toolbar">
        <input class="search" placeholder="Search messages (regex)…" data-action="search">
        <span class="match-count" aria-live="polite"></span>
        <button data-action="jump-latest">Jump to latest</button>
        <label><input type="checkbox" data-action="toggle-path"> Show only current path</label>
        <div class="zoom-group">
          <button data-action="zoom-out" title="Zoom out">−</button>
          <span class="level">100%</span>
          <button data-action="zoom-in" title="Zoom in">+</button>
          <button data-action="zoom-reset" title="Reset zoom">1×</button>
        </div>
      </div>
      <div class="content">
        <div class="tree-pane"></div>
        <div class="preview-pane"></div>
      </div>
    `;
  };

  const paint = (modal, state) => {
    const T = window[NS].tree;
    const { conv } = state;

    // Header — uses innerHTML so the off-path warning can be a colored span
    // instead of an emoji (more consistent with Claude's restrained UI).
    // Both interpolations are safe: chat_messages.length and findBranchPoints
    // return integers, not user-controlled strings.
    modal.querySelector('.title').textContent = conv ? conv.name : 'superclaude';
    let sub = '';
    if (conv) {
      const idx = getIndex(conv);
      const branches = T.findBranchPoints(idx);
      const latest = T.findLatestByTimestamp(conv.chat_messages);
      const offPath = latest && latest.uuid !== conv.current_leaf_message_uuid;
      sub = `${conv.chat_messages.length} msgs · ${branches.length} forks${offPath ? ' · <span class="warn">latest off-path</span>' : ''}`;
    }
    modal.querySelector('.sub').innerHTML = sub;

    // Search input — only sync the DOM value if the user isn't currently
    // typing into it AND state has actually diverged. This is what protects
    // mid-debounce keystrokes from being clobbered by a stale state.query.
    const searchInput = modal.querySelector('.search');
    const shadow = modal.getRootNode();
    if (shadow.activeElement !== searchInput && searchInput.value !== state.query) {
      searchInput.value = state.query;
    }

    // Match count — only shown while a query is active. We re-run the search
    // here (separately from renderTreeSvg's pass) which is cheap on bounded
    // conversation sizes; keeps the count and the muting in lockstep.
    const matchCountEl = modal.querySelector('.match-count');
    if (state.query && conv) {
      const n = T.searchMessages(conv.chat_messages, state.query).length;
      matchCountEl.textContent = n === 0 ? 'no matches' : `${n} match${n === 1 ? '' : 'es'}`;
    } else {
      matchCountEl.textContent = '';
    }

    // Toolbar controls. "Switching…" only applies when we have a conv and
    // a branch-switch is in flight; during the initial load (no conv yet)
    // the label stays "Jump to latest" but disabled so the user can read
    // the button without being confused about what's loading.
    const jumpLatestBtn = modal.querySelector('[data-action="jump-latest"]');
    jumpLatestBtn.textContent = (conv && state.isLoading) ? 'Switching…' : 'Jump to latest';
    jumpLatestBtn.disabled = !conv || !!state.isLoading;

    const togglePath = modal.querySelector('[data-action="toggle-path"]');
    togglePath.checked = !!state.showOnlyPath;

    modal.querySelector('.zoom-group .level').textContent =
      `${Math.round((state.zoom || 1) * 100)}%`;

    // Panes — these still re-render via innerHTML, but the .tree-pane and
    // .preview-pane *containers* persist, so their scrollTop/scrollLeft
    // survive automatically (the browser preserves scroll on the surviving
    // overflow element across content swaps).
    modal.querySelector('.tree-pane').innerHTML = renderTreeSvg(state);
    modal.querySelector('.preview-pane').innerHTML = renderPreview(state);
  };

  // Re-anchored zoom: keep the content point under (anchorX, anchorY) fixed
  // in the viewport. anchorX/Y are viewport coords inside the .tree-pane.
  // Re-queries the pane after setState because the modal's innerHTML rebuild
  // replaces .tree-pane with a fresh node on every render.
  const applyZoom = (shadow, requestedZoom, anchorX, anchorY) => {
    const pane = shadow.querySelector('.tree-pane');
    const oldZ = clampZoom(store.getState().zoom || 1);
    const newZ = clampZoom(requestedZoom);
    if (!pane || newZ === oldZ) {
      if (newZ !== oldZ) store.setState({ zoom: newZ });
      return;
    }
    // Content-space point currently under the anchor.
    const contentX = (pane.scrollLeft + anchorX) / oldZ;
    const contentY = (pane.scrollTop + anchorY) / oldZ;
    store.setState({ zoom: newZ });
    const newPane = shadow.querySelector('.tree-pane');
    if (newPane) {
      newPane.scrollLeft = contentX * newZ - anchorX;
      newPane.scrollTop  = contentY * newZ - anchorY;
    }
  };

  // Anchor zoom buttons to the visible center of the pane.
  const centerOfPane = (shadow) => {
    const pane = shadow.querySelector('.tree-pane');
    if (!pane) return { x: 0, y: 0 };
    const r = pane.getBoundingClientRect();
    return { x: r.width / 2, y: r.height / 2 };
  };

  // Scroll the tree pane so the current-leaf node sits at the pane's
  // visual center. Called once, after the first paint that renders the
  // SVG; subsequent paints (zoom, search, path toggle) leave the user's
  // scroll alone so we don't yank the viewport mid-exploration.
  //
  // Math: bounding-rect delta. The amount we need to scroll equals
  //   (leaf screen center) − (pane screen center)
  // added to the current scroll offset. The browser auto-clamps to the
  // valid scroll range when the tree fits inside the pane.
  const centerOnCurrentLeaf = (modal) => {
    const { conv } = store.getState();
    if (!conv) return;
    const pane = modal.querySelector('.tree-pane');
    if (!pane) return;
    const leafG = pane.querySelector(
      `g.node[data-uuid="${conv.current_leaf_message_uuid}"]`
    );
    if (!leafG) return;
    const paneRect = pane.getBoundingClientRect();
    const leafRect = leafG.getBoundingClientRect();
    pane.scrollLeft += (leafRect.left + leafRect.width  / 2) - (paneRect.left + paneRect.width  / 2);
    pane.scrollTop  += (leafRect.top  + leafRect.height / 2) - (paneRect.top  + paneRect.height / 2);
  };

  const wireEvents = (shadow, onClose) => {
    const modal = shadow.querySelector('.modal');

    modal.addEventListener('click', (e) => {
      const actionEl = e.target.closest('[data-action]');
      if (actionEl) {
        const action = actionEl.getAttribute('data-action');
        if (action === 'close') return onClose();
        if (action === 'jump-latest') {
          window[NS].actions.jumpToLatest();
          return;
        }
        if (action === 'toggle-path') {
          store.setState({ showOnlyPath: !store.getState().showOnlyPath });
          return;
        }
        if (action === 'zoom-in' || action === 'zoom-out' || action === 'zoom-reset') {
          const oldZ = clampZoom(store.getState().zoom || 1);
          const next = action === 'zoom-reset' ? 1
                     : action === 'zoom-in'    ? oldZ * ZOOM_FACTOR
                                               : oldZ / ZOOM_FACTOR;
          const c = centerOfPane(shadow);
          applyZoom(shadow, next, c.x, c.y);
          return;
        }
        if (action === 'jump') {
          window[NS].actions.jumpTo(actionEl.getAttribute('data-uuid'));
          return;
        }
      }
      const node = e.target.closest('.node[data-uuid]');
      if (node) store.setState({ selected: node.getAttribute('data-uuid') });
    });

    // Debounce search so we don't rerender the SVG on every keystroke.
    let timer = null;
    modal.addEventListener('input', (e) => {
      if (!e.target.matches('[data-action="search"]')) return;
      clearTimeout(timer);
      const v = e.target.value;
      timer = setTimeout(() => store.setState({ query: v }), 180);
    });

    // Cmd/Ctrl + wheel = zoom; plain wheel scrolls the pane normally.
    // Delegated on the persistent .modal element (not the .tree-pane, which
    // is replaced on every rerender) so listeners don't accumulate.
    // passive:false so we can preventDefault and stop the page from zooming.
    modal.addEventListener('wheel', (e) => {
      const pane = e.target.closest('.tree-pane');
      if (!pane) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const rect = pane.getBoundingClientRect();
      const ax = e.clientX - rect.left;
      const ay = e.clientY - rect.top;
      const oldZ = clampZoom(store.getState().zoom || 1);
      const factor = e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
      applyZoom(shadow, oldZ * factor, ax, ay);
    }, { passive: false });
  };

  const mountUI = () => {
    if (document.getElementById(HOST_ID)) return null;
    const host = document.createElement('div');
    host.id = HOST_ID;
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${STYLES}</style><div class="backdrop"></div><div class="modal"></div>`;
    window[NS].modalOpen = true;

    // Claude.ai installs a document-level keydown handler that refocuses its
    // chat composer on every keystroke. Stop key events at our shadow host
    // so claude's listener never sees them; the inner input still receives
    // the keystroke because propagation only halts at the shadow boundary.
    // Escape is allowed through so the document-level Esc-to-close still
    // fires.
    const stopKeyAtHost = (e) => { if (e.key !== 'Escape') e.stopPropagation(); };
    host.addEventListener('keydown',  stopKeyAtHost);
    host.addEventListener('keyup',    stopKeyAtHost);
    host.addEventListener('keypress', stopKeyAtHost);

    let unsub = null;
    const close = () => {
      if (unsub) unsub();
      document.removeEventListener('keydown', onKey);
      host.remove();
      window[NS].modalOpen = false;
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    shadow.querySelector('.backdrop').addEventListener('click', close);

    // Build the static DOM skeleton once; wire events once on the persistent
    // .modal element; then paint reactively on every store update. The input,
    // buttons, checkbox, and pane containers persist across paints, so focus,
    // cursor position, in-flight typed text, and scroll positions all survive
    // without any snapshot/restore gymnastics.
    //
    // First-paint hook: after the initial paint that has the conv loaded,
    // scroll the tree pane so the current leaf is centered. `centered`
    // latches so later store updates (search, zoom, path toggle) don't
    // yank the user's scroll position.
    const modal = shadow.querySelector('.modal');
    buildSkeleton(modal);
    wireEvents(shadow, close);
    let centered = false;
    const refresh = (s) => {
      paint(modal, s);
      if (!centered && s.conv) {
        // rAF gives the browser a tick to lay out the freshly-painted SVG
        // before we measure its bounding rect.
        requestAnimationFrame(() => centerOnCurrentLeaf(modal));
        centered = true;
      }
    };
    refresh(store.getState());
    unsub = store.subscribe(refresh);
    return close;
  };

  window[NS].mountUI = mountUI;

  // ---------------------------------------------------------------------------
  // Layer 6: Actions
  //
  // Side-effectful operations that compose API client + state store +
  // navigation. Each action owns its own try/catch and reports failures via
  // toast + state.error; success paths either update the store or trigger a
  // full page reload (for branch-switching, since Claude's React tree won't
  // re-fetch on its own).
  // ---------------------------------------------------------------------------

  const handleActionError = (label, err) => {
    store.setState({ isLoading: false, error: err });
    const tag = err instanceof ApiError ? `[${err.code}]` : '';
    toast(`${label} failed — ${tag} ${err.message}`.trim(), { kind: 'error', timeoutMs: 8000 });
    console.error('[superclaude]', err);
  };

  // Delete any IndexedDB records (across all databases / object stores) whose
  // key or serialized value mentions the given conv UUID. Claude.ai stores
  // the conversation tree in an `idb-keyval` database (`keyval-store/keyval`)
  // and hydrates from it on page load — without this wipe, location.reload()
  // re-renders the old leaf because the chat boot path reads from IDB before
  // (and often instead of) the network. Best-effort; resolves silently on any
  // database error so a hung IDB never blocks the actual reload.
  const wipeIDBForConv = async (convUuid) => {
    if (!window.indexedDB || typeof indexedDB.databases !== 'function') return;
    let dbs;
    try { dbs = await indexedDB.databases(); } catch { return; }
    for (const { name } of dbs) {
      if (!name) continue;
      await new Promise((resolveDb) => {
        const openReq = indexedDB.open(name);
        openReq.onerror = () => resolveDb();
        openReq.onsuccess = () => {
          const db = openReq.result;
          const stores = Array.from(db.objectStoreNames);
          if (!stores.length) { db.close(); return resolveDb(); }
          let tx;
          try { tx = db.transaction(stores, 'readwrite'); }
          catch { db.close(); return resolveDb(); }
          tx.oncomplete = () => { db.close(); resolveDb(); };
          tx.onerror    = () => { db.close(); resolveDb(); };
          tx.onabort    = () => { db.close(); resolveDb(); };
          for (const storeName of stores) {
            const store = tx.objectStore(storeName);
            const keysReq = store.getAllKeys();
            keysReq.onsuccess = () => {
              const valsReq = store.getAll();
              valsReq.onsuccess = () => {
                const keys = keysReq.result || [];
                const vals = valsReq.result || [];
                for (let i = 0; i < keys.length; i++) {
                  let mentions = false;
                  try {
                    if (typeof keys[i] === 'string' && keys[i].includes(convUuid)) mentions = true;
                    else if (JSON.stringify(vals[i]).includes(convUuid)) mentions = true;
                  } catch {}
                  if (mentions) {
                    try { store.delete(keys[i]); } catch {}
                  }
                }
              };
            };
          }
        };
      });
    }
  };

  const Actions = {
    // Initial load: discover the org, fetch the tree, hydrate the store.
    // Called once at boot; safe to call again to refresh (e.g. after the user
    // sends a new message in another tab).
    loadConversation: async (uuid) => {
      store.setState({ isLoading: true, error: null });
      try {
        const orgs = await listOrgs();
        const org = pickChatOrg(orgs);
        if (!org) {
          // Not an HTTP failure — orgs were fetched successfully, none was
          // chat-capable. Surface a dedicated message so the toast doesn't
          // read "Load failed — [http] ..." for what is really an account
          // configuration issue.
          store.setState({ isLoading: false });
          toast('No chat-capable Claude.ai org found on this account.', { kind: 'error', timeoutMs: 8000 });
          return null;
        }
        const conv = await getConversation(org.uuid, uuid);
        store.setState({
          isLoading: false,
          org, conv,
          selected: conv.current_leaf_message_uuid,
        });
        return conv;
      } catch (err) {
        handleActionError('Load', err);
        return null;
      }
    },

    // Commit: PUT the new leaf, then reload the page so Claude's UI rehydrates
    // from the server with the new branch. We don't try to surgically patch
    // Claude's React state — see system design notes on "mutate via reload".
    jumpTo: async (leafUuid) => {
      const { org, conv } = store.getState();
      if (!org || !conv) {
        toast('Conversation not loaded yet.', { kind: 'error' });
        return;
      }
      if (leafUuid === conv.current_leaf_message_uuid) {
        toast('Already on this branch.', { kind: 'info' });
        return;
      }
      store.setState({ isLoading: true, error: null });
      toast('Switching branch…', { kind: 'info', timeoutMs: 2000 });
      try {
        await setCurrentLeaf(org.uuid, conv.uuid, leafUuid);
        // Claude.ai persists the conversation tree in IndexedDB (idb-keyval)
        // and hydrates from it on page load — the /versions endpoint check
        // doesn't catch a leaf change, so a plain reload re-renders the old
        // branch. Wipe IDB entries mentioning this conv first; the reload
        // then falls back to a fresh API fetch and the chat updates.
        await wipeIDBForConv(conv.uuid);
        location.reload();
      } catch (err) {
        handleActionError('Jump', err);
      }
    },

    // Convenience: find the message with the max created_at and jump to it.
    // Solves the original problem that motivated superclaude: "the latest reply
    // is hidden somewhere in the tree and the arrow UI won't get me there".
    jumpToLatest: () => {
      const { conv } = store.getState();
      if (!conv) return;
      const latest = window[NS].tree.findLatestByTimestamp(conv.chat_messages);
      if (!latest) return;
      return Actions.jumpTo(latest.uuid);
    },
  };

  window[NS].actions = Actions;

  // ---------------------------------------------------------------------------
  // Boot: mount the UI shell immediately, fire the conv fetch in parallel.
  //
  // Earlier versions awaited loadConversation before mountUI, which made the
  // bookmark click feel like it did nothing for the duration of the network
  // round trip (200 ms on warm cache, several seconds on a cold fetch of a
  // big tree). Mounting first means the modal appears the same frame the
  // click registers; its empty state reads "Loading conversation…" until
  // the store update from loadConversation triggers a repaint with the
  // tree filled in. If the fetch fails, the empty state shows the error
  // and the user can read it before pressing Esc to dismiss.
  // ---------------------------------------------------------------------------
  mountUI();
  Actions.loadConversation(convUuid);
})();
