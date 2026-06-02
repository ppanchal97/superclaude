// Build: minify bookmarklet.js with terser, URL-encode, write `dist/`.
// Commits an auditable artifact so users on the landing page install exactly
// what's checked into the repo — no hidden mutation between source and link.
//
// Run: `npm run build`
// Outputs:
//   dist/bookmarklet.url   — the raw `javascript:…` URL, one line
//   dist/install.html      — install page with drag target + manual fallback
//   index.html             — public landing page for GitHub Pages, with the
//                            bookmarklet URL inlined as the drag target
//
// Fails if the encoded URL exceeds MAX_URL_BYTES (60 KB; Chrome's bookmarklet
// URL ceiling is reported around 64 KB and Safari's is lower — staying under
// 60 leaves headroom).

const fs = require('fs');
const path = require('path');
const { minify } = require('terser');

const SOURCE = path.join(__dirname, 'bookmarklet.js');
const DIST = path.join(__dirname, 'dist');
const MAX_URL_BYTES = 60 * 1024;

(async () => {
  const src = fs.readFileSync(SOURCE, 'utf8');

  const result = await minify(src, {
    compress: {
      passes: 2,
      drop_console: false,  // we don't log in prod, but `console.error` paths exist; keep them
      pure_funcs: [],
    },
    mangle: true,
    format: {
      comments: false,
      ascii_only: true,     // shrinks % escapes after encodeURIComponent
    },
    ecma: 2020,
  });

  if (!result.code) throw new Error('terser returned no code');

  // The source is wrapped in its own IIFE; terser preserves that. Just URL-
  // encode and prefix `javascript:` — no extra wrapping needed.
  const url = 'javascript:' + encodeURIComponent(result.code);

  if (url.length > MAX_URL_BYTES) {
    throw new Error(
      `bookmarklet URL is ${url.length} bytes, over the ${MAX_URL_BYTES}-byte ceiling. ` +
      `Reduce source size before shipping.`
    );
  }

  fs.mkdirSync(DIST, { recursive: true });

  fs.writeFileSync(path.join(DIST, 'bookmarklet.url'), url + '\n');

  // Install page with two install paths:
  //   1. Drag (preferred — one gesture, works in some browsers)
  //   2. Manual create + paste (always works — recent Chrome strips the
  //      `javascript:` scheme during drag, so the dragged bookmark fails
  //      open and the click ends up in the omnibox as a search query)
  const safeUrlHref = url.replace(/"/g, '&quot;');
  const safeUrlText = url.replace(/&/g, '&amp;').replace(/</g, '&lt;');

  // Inline SVG favicon (clay rounded square + cream sparkle, matching the
  // landing-page chip). Data URI so each page is self-contained — no separate
  // file to 404 and no path juggling between root and dist/. NOTE: this brands
  // the install/landing *pages*; it cannot brand the bookmarklet itself, since
  // a `javascript:` bookmark has no host to pull a favicon from and browsers
  // fall back to the default globe. The README documents the icon-preserving
  // install (bookmark this page, then swap its URL) for users who want it.
  const FAVICON =
    `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,` +
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>` +
    `<rect width='24' height='24' rx='5' fill='%23d97757'/>` +
    `<path d='M12 3.5C12.5 8.2 15.8 11.5 20.5 12 15.8 12.5 12.5 15.8 12 20.5 ` +
    `11.5 15.8 8.2 12.5 3.5 12 8.2 11.5 11.5 8.2 12 3.5Z' fill='%23fdfdfc'/>` +
    `</svg>">`;
  const installHtml = `<!doctype html>
<meta charset="utf-8">
<title>superclaude — install</title>
${FAVICON}
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    --bg: #181715;
    --text: hsl(60 14% 97%);
    --text-2: hsl(55 9% 74%);
    --text-3: hsl(48 5% 57%);
    --border: hsl(53 12% 87% / 0.10);
    --clay: hsl(14.8 63.1% 59.6%);
    --serif: Georgia, "Times New Roman", Times, serif;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--text);
               font-family: var(--sans); -webkit-font-smoothing: antialiased;
               -moz-osx-font-smoothing: grayscale; }
  body { max-width: 720px; margin: 0 auto; padding: 0 24px 80px;
         font-size: 15px; line-height: 1.6; }
  ::selection { background: var(--clay); color: var(--bg); }
  a { color: var(--text-2); }
  a:hover { color: var(--text); }
  code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.9em;
         background: hsl(53 12% 87% / 0.08); padding: 1px 6px; border-radius: 4px;
         color: var(--text); }

  .topbar { display: flex; align-items: center; justify-content: space-between;
            padding: 26px 0 10px; }
  .brand { font-family: var(--serif); font-style: italic; font-size: 20px;
           letter-spacing: -0.01em; }
  .brand .star { color: var(--clay); font-style: normal; margin-right: 2px; }
  .topbar a { font-size: 14px; text-decoration: none; }

  h1 { font-family: var(--serif); font-weight: 400; letter-spacing: -0.02em;
       font-size: clamp(32px, 5vw, 44px); line-height: 1.08; margin: 24px 0 10px; }
  .lede { font-size: 17px; color: var(--text-2); margin: 0; line-height: 1.5; }
  h2 { font-family: var(--serif); font-weight: 400; letter-spacing: -0.01em;
       font-size: 23px; margin: 52px 0 8px; }
  p { margin: 10px 0; color: var(--text-2); }
  ol { padding-left: 22px; color: var(--text-2); line-height: 1.75; }
  li { margin: 5px 0; }
  b { color: var(--text); font-weight: 600; }
  .note { color: var(--text-3); font-size: 13px; }

  /* Draggable bookmark chip — identical to the landing-page CTA so the two
     pages read as one product, not two. */
  .install-zone { margin: 18px 0 4px; }
  .drag-hint { display: inline-flex; align-items: center; gap: 7px;
               margin: 0 0 14px 4px; font-size: 13px; color: var(--text-3); }
  .drag-hint .arrow { display: inline-flex; fill: var(--clay);
                      animation: nudge-up 1.8s ease-in-out infinite; }
  @keyframes nudge-up { 0%, 100% { transform: translateY(1px); }
                        50%      { transform: translateY(-3px); } }
  .chip-float { display: inline-block; animation: float 3s ease-in-out infinite; }
  @keyframes float { 0%, 100% { transform: translateY(0); }
                     50%      { transform: translateY(-6px); } }
  .bookmarklet-chip {
    display: inline-flex; align-items: center; gap: 11px;
    padding: 12px 20px 12px 13px; border-radius: 13px;
    background: var(--text); color: #1f1d1a;
    font-size: 15.5px; font-weight: 600; letter-spacing: -0.01em;
    text-decoration: none; cursor: grab; user-select: none;
    box-shadow: 0 14px 34px -10px rgb(0 0 0 / 0.55),
                0 1px 0 0 hsl(0 0% 100% / 0.55) inset;
    transition: transform 0.18s ease, box-shadow 0.18s ease;
  }
  .bookmarklet-chip:hover { transform: translateY(-2px);
    box-shadow: 0 20px 44px -10px rgb(0 0 0 / 0.6),
                0 1px 0 0 hsl(0 0% 100% / 0.55) inset; }
  .bookmarklet-chip:active { cursor: grabbing; transform: scale(0.99); }
  .chip-grip { display: flex; flex-shrink: 0; fill: #b9b3a6; }
  .chip-star { display: flex; flex-shrink: 0; fill: var(--clay); }
  @media (prefers-reduced-motion: reduce) {
    .chip-float, .drag-hint .arrow { animation: none; }
  }

  /* Numbered two-step flow: a clay badge + body per step, so the path from
     "install" to "use" reads at a glance instead of as four equal headings. */
  ol.steps { list-style: none; margin: 40px 0 0; padding: 0; }
  .step { display: flex; gap: 18px; }
  .step + .step { margin-top: 22px; }
  .step-num { flex-shrink: 0; width: 30px; height: 30px; border-radius: 50%;
              background: var(--clay); color: #1f1d1a; font-weight: 700;
              font-size: 15px; display: flex; align-items: center;
              justify-content: center; margin-top: 3px; }
  .step-body { flex: 1; min-width: 0; }
  .step-body > h2 { margin: 2px 0 8px; font-size: 22px; }
  .step-body > p { margin: 0 0 10px; }

  /* The install action gets a defined card so the drag target reads as one
     deliberate module, not loose text. */
  .install-card { display: flex; flex-direction: column; align-items: center;
                  gap: 2px; padding: 30px 24px 32px; margin: 6px 0 12px;
                  background: hsl(60 2% 11%); border: 1px solid var(--border);
                  border-radius: 14px; }

  /* Manual / technical path collapsed by default — present for the ~5% who
     need it, invisible to everyone else. */
  details.manual { margin-top: 8px; }
  details.manual > summary { cursor: pointer; list-style: none;
    display: inline-flex; align-items: center; gap: 7px; font-size: 13.5px;
    color: var(--text-2); user-select: none; }
  details.manual > summary::-webkit-details-marker { display: none; }
  details.manual > summary::before { content: "›"; color: var(--text-3);
    font-size: 16px; line-height: 1; transition: transform 0.15s ease;
    display: inline-block; }
  details.manual[open] > summary::before { transform: rotate(90deg); }
  details.manual > summary:hover { color: var(--text); }
  .manual-body { margin-top: 14px; padding-left: 2px; }

  textarea { width: 100%; box-sizing: border-box; margin-top: 4px;
             background: hsl(60 2% 9%); color: var(--text-2);
             padding: 12px 14px; border: 1px solid var(--border);
             border-radius: 8px; font-size: 11px;
             font-family: ui-monospace, Menlo, monospace; height: 104px;
             resize: vertical; white-space: pre-wrap; word-break: break-all; }
  button { padding: 9px 16px; background: var(--text); color: #1f1d1a; border: 0;
           border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600;
           font-family: inherit; transition: background-color 0.15s; }
  button:hover { background: hsl(60 14% 90%); }
  .meta { color: var(--text-3); font-size: 12px; margin-top: 52px;
          padding-top: 22px; border-top: 1px solid var(--border); }
</style>
<div class="topbar">
  <div class="brand"><span class="star">✦</span>superclaude</div>
  <a href="../index.html">← Home</a>
</div>

<h1>Install superclaude</h1>
<p class="lede">See every branch of a Claude.ai conversation — and jump to any leaf in one click.</p>

<ol class="steps">
  <li class="step">
    <div class="step-num">1</div>
    <div class="step-body">
      <h2>Add the bookmark</h2>
      <div class="install-card">
        <p class="drag-hint">
          <span class="arrow" aria-hidden="true"><svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 2.5l4.5 5H9.5v6h-3v-6H3.5z"/></svg></span>
          Drag this up to your bookmarks bar
        </p>
        <span class="chip-float">
          <a class="bookmarklet-chip" href="${safeUrlHref}" title="Drag me to your bookmarks bar">
            <span class="chip-grip" aria-hidden="true"><svg viewBox="0 0 10 16" width="10" height="16"><circle cx="2.5" cy="3" r="1.3"/><circle cx="7.5" cy="3" r="1.3"/><circle cx="2.5" cy="8" r="1.3"/><circle cx="7.5" cy="8" r="1.3"/><circle cx="2.5" cy="13" r="1.3"/><circle cx="7.5" cy="13" r="1.3"/></svg></span>
            <span class="chip-star" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 2C12.6 7.4 16.6 11.4 22 12 16.6 12.6 12.6 16.6 12 22 11.4 16.6 7.4 12.6 2 12 7.4 11.4 11.4 7.4 12 2Z"/></svg></span>
            <span class="chip-label">superclaude</span>
          </a>
        </span>
      </div>
      <details class="manual">
        <summary>Bookmark won't drag? Install it by hand (and get the ✦ icon)</summary>
        <div class="manual-body">
          <p class="note">Some browsers — recent Chrome especially — strip the
          <code>javascript:</code> scheme when you drag, and a dragged bookmarklet
          can only ever show a generic globe icon. Installing by hand avoids both:
          let the bookmark inherit this page's ✦ icon, then swap in the code.</p>
          <ol>
            <li>Bookmark <b>this page</b> (<code>Cmd/Ctrl+D</code>) — the new bookmark
                picks up the ✦ icon from the tab.</li>
            <li>Edit that bookmark, replace its URL with the one below, and keep the name.</li>
            <li>It now runs superclaude and shows the sparkle instead of the globe.</li>
          </ol>
          <p><button id="copy">Copy bookmarklet URL</button>
             <span id="copy-status" class="note"></span></p>
          <textarea id="url" readonly>${safeUrlText}</textarea>
        </div>
      </details>
    </div>
  </li>

  <li class="step">
    <div class="step-num">2</div>
    <div class="step-body">
      <h2>Use it</h2>
      <p>Open any chat at <code>claude.ai/chat/…</code> and click the
        <b>superclaude</b> bookmark. A window opens with the conversation's full
        branch tree.</p>
      <p>Click any node to preview that message, then <b>Jump to this branch</b> to
        switch the conversation there — or <b>Jump to latest</b> to leap to the
        newest message across every branch.</p>
    </div>
  </li>
</ol>

<p class="meta">Bookmarklet size: ${url.length.toLocaleString()} bytes (well under the ~${MAX_URL_BYTES.toLocaleString()}-byte browser limit).</p>

<script>
document.getElementById('copy').addEventListener('click', async () => {
  const ta = document.getElementById('url');
  ta.select();
  try {
    await navigator.clipboard.writeText(ta.value);
    document.getElementById('copy-status').textContent = 'copied';
  } catch {
    document.execCommand('copy');
    document.getElementById('copy-status').textContent = 'copied (fallback)';
  }
  setTimeout(() => { document.getElementById('copy-status').textContent = ''; }, 2000);
});
</script>
`;
  fs.writeFileSync(path.join(DIST, 'install.html'), installHtml);

  // Public landing page (root index.html, served by GitHub Pages).
  // Asymmetric two-column hero + feature section, dark Claude-inspired palette.
  // The primary CTA is the bookmarklet itself, draggable directly to bookmarks.
  // Video areas are deliberately empty placeholders — captions describe what
  // belongs there so a future recording can drop in without reflowing layout.
  const landingHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>superclaude — see every branch of your Claude conversation</title>
<meta name="description" content="A bookmarklet that visualizes the branch tree of any claude.ai conversation and lets you jump to any leaf in one click.">
${FAVICON}
<script>document.documentElement.classList.add('js');</script>
<style>
  :root {
    --bg: #181715;
    --text: hsl(60 14% 97%);
    --text-2: hsl(55 9% 74%);
    --text-3: hsl(48 5% 57%);
    --border: hsl(53 12% 87% / 0.10);
    --clay: hsl(14.8 63.1% 59.6%);
    --beige: #ece2cc;
    --sage: #d2dfd6;
    --serif: Georgia, "Times New Roman", Times, serif;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text);
               font-family: var(--sans); -webkit-font-smoothing: antialiased;
               -moz-osx-font-smoothing: grayscale; }
  ::selection { background: var(--clay); color: var(--bg); }
  a { color: inherit; }
  code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.92em;
         background: hsl(53 12% 87% / 0.08); padding: 1px 6px; border-radius: 4px; }

  .wrap { max-width: 1200px; margin: 0 auto; padding: 0 32px; }

  header { padding: 28px 0 8px; }
  .nav { display: flex; align-items: center; justify-content: space-between; }
  .brand { font-family: var(--serif); font-style: italic; font-size: 24px;
           letter-spacing: -0.01em; }
  .brand .star { color: var(--clay); font-style: normal; margin-right: 2px; }
  .nav-links { display: flex; gap: 28px; font-size: 14px; color: var(--text-2); }
  .nav-links a { text-decoration: none; }
  .nav-links a:hover { color: var(--text); }

  .hero { padding: 72px 0 60px; }
  .hero-grid { display: grid; grid-template-columns: 1fr; gap: 56px;
               align-items: center; }
  @media (min-width: 900px) {
    .hero-grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr); gap: 72px; }
  }
  .headline { font-family: var(--serif); font-weight: 400;
              font-size: clamp(40px, 6vw, 72px); line-height: 1.04;
              letter-spacing: -0.025em; margin: 0 0 24px; }
  .subhead { font-size: 18px; line-height: 1.55; color: var(--text-2);
             margin: 0 0 36px; max-width: 520px; }
  .cta-row { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
  .btn { display: inline-flex; align-items: center; padding: 13px 24px;
         border-radius: 999px; font-size: 15px; font-weight: 500;
         text-decoration: none; font-family: inherit; border: 1px solid transparent;
         cursor: pointer; transition: background-color 0.15s, border-color 0.15s; }
  .btn-secondary { background: transparent; color: var(--text);
                   border-color: var(--border); }
  .btn-secondary:hover { border-color: hsl(53 12% 87% / 0.25); }

  /* The install CTA is a draggable bookmark chip, not a button. Grip dots +
     idle float + grab cursor all signal "pick me up and drag me," and the
     sparkle + label make it preview as the bookmark it becomes on drop. */
  .install-zone { margin-top: 4px; }
  .drag-hint { display: inline-flex; align-items: center; gap: 7px;
               margin: 0 0 14px 4px; font-size: 13px; color: var(--text-3);
               letter-spacing: 0.01em; }
  .drag-hint .arrow { display: inline-flex; fill: var(--clay);
                      animation: nudge-up 1.8s ease-in-out infinite; }
  @keyframes nudge-up {
    0%, 100% { transform: translateY(1px); }
    50%      { transform: translateY(-3px); }
  }

  .chip-float { display: inline-block; animation: float 3s ease-in-out infinite; }
  @keyframes float {
    0%, 100% { transform: translateY(0); }
    50%      { transform: translateY(-6px); }
  }

  .bookmarklet-chip {
    display: inline-flex; align-items: center; gap: 11px;
    padding: 12px 20px 12px 13px; border-radius: 13px;
    background: var(--text); color: #1f1d1a;
    font-size: 15.5px; font-weight: 600; letter-spacing: -0.01em;
    text-decoration: none; cursor: grab; user-select: none;
    box-shadow: 0 14px 34px -10px rgb(0 0 0 / 0.55),
                0 1px 0 0 hsl(0 0% 100% / 0.55) inset;
    transition: transform 0.18s var(--ease, ease), box-shadow 0.18s ease;
  }
  .bookmarklet-chip:hover {
    transform: translateY(-2px);
    box-shadow: 0 20px 44px -10px rgb(0 0 0 / 0.6),
                0 1px 0 0 hsl(0 0% 100% / 0.55) inset;
  }
  .bookmarklet-chip:active { cursor: grabbing; transform: scale(0.99); }
  .chip-grip { display: flex; flex-shrink: 0; fill: #b9b3a6; }
  .chip-star { display: flex; flex-shrink: 0; fill: var(--clay); }

  @media (prefers-reduced-motion: reduce) {
    .chip-float, .drag-hint .arrow { animation: none; }
  }

  .install-fallback { margin: 18px 0 0 4px; font-size: 13px; color: var(--text-3); }
  .install-fallback a { color: var(--text-2); text-decoration: underline;
                        text-underline-offset: 2px; }
  .install-fallback a:hover { color: var(--text); }

  .demo { aspect-ratio: 4 / 3; border-radius: 28px; display: flex;
          align-items: center; justify-content: center; position: relative;
          overflow: hidden; }
  .demo-beige { background: var(--beige); }
  .demo-sage  { background: var(--sage); }
  .demo .play { width: 68px; height: 68px; background: hsl(40 8% 14%);
                border-radius: 18px; display: flex; align-items: center;
                justify-content: center;
                box-shadow: 0 12px 32px rgb(0 0 0 / 0.22); }
  .demo .play svg { width: 24px; height: 24px; fill: white; margin-left: 4px; }
  .demo .caption { position: absolute; bottom: 20px; left: 24px; right: 24px;
                   font-size: 12px; letter-spacing: 0.02em;
                   color: hsl(40 8% 28%); text-transform: uppercase; }

  .section { padding: 100px 0; border-top: 1px solid var(--border); }
  .feature-grid { display: grid; grid-template-columns: 1fr; gap: 56px;
                  align-items: center; }
  @media (min-width: 900px) {
    .feature-grid { grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 80px; }
    .feature-grid.reverse { grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr); }
    .feature-grid.reverse .text { order: 2; }
  }
  .section-title { font-family: var(--serif); font-weight: 400;
                   font-size: clamp(30px, 4vw, 44px); line-height: 1.1;
                   letter-spacing: -0.02em; margin: 0 0 22px; }
  .section-body { font-size: 17px; line-height: 1.6; color: var(--text-2);
                  margin: 0; max-width: 480px; }

  .closing { padding: 96px 0; text-align: center; border-top: 1px solid var(--border); }
  .closing h2 { font-family: var(--serif); font-weight: 400;
                font-size: clamp(28px, 3.5vw, 40px); margin: 0 0 18px;
                letter-spacing: -0.02em; }
  .closing p { color: var(--text-2); font-size: 16px; max-width: 560px;
               margin: 0 auto 32px; line-height: 1.6; }
  .closing .browser-note { margin-top: 26px; font-size: 13px; color: var(--text-3); }

  footer { padding: 36px 0 56px; color: var(--text-3); font-size: 13px;
           border-top: 1px solid var(--border); }
  .footer-row { display: flex; justify-content: space-between; align-items: center;
                flex-wrap: wrap; gap: 16px; }
  footer a { color: var(--text-3); text-decoration: none; }
  footer a:hover { color: var(--text-2); }

  /* Scroll-triggered reveals. The .js gate ensures no-JS visitors see content
     immediately (otherwise .reveal would stay at opacity 0 forever). */
  .js .reveal { opacity: 0; transform: translateY(28px);
                transition: opacity 0.8s cubic-bezier(0.22, 1, 0.36, 1),
                            transform 0.8s cubic-bezier(0.22, 1, 0.36, 1); }
  .js .reveal.is-visible { opacity: 1; transform: none; }
  @media (prefers-reduced-motion: reduce) {
    .js .reveal, .js .reveal.is-visible {
      opacity: 1; transform: none; transition: none;
    }
  }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <nav class="nav">
        <div class="brand"><span class="star">✦</span>superclaude</div>
        <div class="nav-links">
          <a href="./dist/install.html">Install</a>
          <a href="https://github.com/ppanchal97/superclaude">GitHub</a>
        </div>
      </nav>
    </header>

    <section class="hero reveal">
      <div class="hero-grid">
        <div>
          <h1 class="headline">See every branch of your Claude conversation.</h1>
          <p class="subhead">A bookmarklet that maps out every fork in any
            claude.ai chat — and lets you jump back to any leaf in one click.</p>
          <div class="install-zone">
            <p class="drag-hint">
              <span class="arrow" aria-hidden="true"><svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 2.5l4.5 5H9.5v6h-3v-6H3.5z"/></svg></span>
              Drag this up to your bookmarks bar
            </p>
            <span class="chip-float">
              <a class="bookmarklet-chip" href="${safeUrlHref}" title="Drag me to your bookmarks bar">
                <span class="chip-grip" aria-hidden="true"><svg viewBox="0 0 10 16" width="10" height="16"><circle cx="2.5" cy="3" r="1.3"/><circle cx="7.5" cy="3" r="1.3"/><circle cx="2.5" cy="8" r="1.3"/><circle cx="7.5" cy="8" r="1.3"/><circle cx="2.5" cy="13" r="1.3"/><circle cx="7.5" cy="13" r="1.3"/></svg></span>
                <span class="chip-star" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 2C12.6 7.4 16.6 11.4 22 12 16.6 12.6 12.6 16.6 12 22 11.4 16.6 7.4 12.6 2 12 7.4 11.4 11.4 7.4 12 2Z"/></svg></span>
                <span class="chip-label">superclaude</span>
              </a>
            </span>
            <p class="install-fallback">Can't drag it?
              <a href="./dist/install.html">Install it manually →</a></p>
          </div>
        </div>
        <div class="demo demo-beige" aria-label="Demo placeholder: tree view">
          <div class="play" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 4l14 8-14 8V4z"/></svg></div>
          <div class="caption">Demo · the tree view</div>
        </div>
      </div>
    </section>

    <section class="section reveal">
      <div class="feature-grid reverse">
        <div class="text">
          <h2 class="section-title">Find the reply you remember writing.</h2>
          <p class="section-body">Editing a message or asking Claude to retry
            creates a new branch — but Claude's UI only shows one path at a
            time. The reply you remember is often the latest leaf of a sibling
            you can't see, sitting behind a string of <code>&lt; 2/3 &gt;</code>
            clicks. superclaude shows them all at once, and a single click on
            any node switches your conversation to that branch.</p>
        </div>
        <div class="demo demo-sage" aria-label="Demo placeholder: jumping branches">
          <div class="play" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 4l14 8-14 8V4z"/></svg></div>
          <div class="caption">Demo · jumping branches</div>
        </div>
      </div>
    </section>

    <section class="closing reveal">
      <h2>Open-source. Audit before you install.</h2>
      <p>superclaude is one self-contained file. No third-party servers, no
        telemetry. It calls only Claude.ai's own API, writes one field — the
        current leaf UUID — and refuses to run anywhere outside
        <code>claude.ai/chat/</code>. CI verifies the install URL on this page
        matches a fresh build of the source you can read.</p>
      <div class="cta-row" style="justify-content: center;">
        <a class="btn btn-secondary" href="https://github.com/ppanchal97/superclaude#audit-before-installing">Read the audit guide</a>
      </div>
      <p class="browser-note">Tested in Chrome. Edge should work (same engine).
        Arc blocks <code>javascript:</code> bookmarklets at the scheme level
        and is not supported. Firefox and Safari are untested.</p>
    </section>

    <footer class="reveal">
      <div class="footer-row">
        <div>MIT · Built by <a href="https://github.com/ppanchal97">Rick Panchal</a></div>
        <div><a href="https://github.com/ppanchal97/superclaude">github.com/ppanchal97/superclaude</a></div>
      </div>
    </footer>
  </div>
  <script>
    // Reveal each .reveal block as it enters the viewport. One-shot —
    // unobserve once visible so re-entering scroll doesn't re-trigger.
    (function () {
      var els = document.querySelectorAll('.reveal');
      if (!('IntersectionObserver' in window)) {
        // Old browser: just show everything.
        for (var i = 0; i < els.length; i++) els[i].classList.add('is-visible');
        return;
      }
      var io = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].isIntersecting) {
            entries[i].target.classList.add('is-visible');
            io.unobserve(entries[i].target);
          }
        }
      }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
      for (var j = 0; j < els.length; j++) io.observe(els[j]);
    })();
  </script>
</body>
</html>
`;
  fs.writeFileSync(path.join(__dirname, 'index.html'), landingHtml);

  const sourceBytes = Buffer.byteLength(src, 'utf8');
  const minBytes = Buffer.byteLength(result.code, 'utf8');
  console.log(`source:    ${sourceBytes.toLocaleString()} bytes`);
  console.log(`minified:  ${minBytes.toLocaleString()} bytes (${(minBytes / sourceBytes * 100).toFixed(1)}% of source)`);
  console.log(`url:       ${url.length.toLocaleString()} bytes (${(url.length / MAX_URL_BYTES * 100).toFixed(1)}% of ${MAX_URL_BYTES.toLocaleString()})`);
  console.log(`wrote:     dist/bookmarklet.url, dist/install.html, index.html`);
})().catch((err) => {
  console.error('build failed:', err.message);
  process.exit(1);
});
