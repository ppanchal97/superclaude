// Build: minify bookmarklet.js with terser, URL-encode, write `dist/`.
// Commits an auditable artifact so users on the landing page install exactly
// what's checked into the repo — no hidden mutation between source and link.
//
// Run: `npm run build`
// Outputs:
//   dist/bookmarklet.url   — the raw `javascript:…` URL, one line
//   dist/install.html      — test page with draggable link + size readout
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
  const installHtml = `<!doctype html>
<meta charset="utf-8">
<title>branchview — install</title>
<style>
  body { font: 14px/1.55 -apple-system, system-ui, sans-serif;
         max-width: 680px; margin: 40px auto; padding: 0 20px; color: #222; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  h2 { font-size: 15px; margin-top: 28px; color: #444; }
  p  { margin: 8px 0; }
  ol { padding-left: 20px; }
  li { margin: 4px 0; }
  .install { display: inline-block; padding: 9px 18px; margin: 8px 0;
             background: #4a90e2; color: #fff; border-radius: 6px;
             text-decoration: none; font-weight: 500; cursor: grab; }
  .install:active { cursor: grabbing; }
  pre, textarea {
    width: 100%; box-sizing: border-box;
    background: #f5f5f7; padding: 10px 12px; border: 1px solid #e0e0e3;
    border-radius: 6px; font-size: 11px; font-family: ui-monospace, Menlo, monospace;
    overflow-x: auto; white-space: pre-wrap; word-break: break-all;
  }
  textarea { height: 96px; resize: vertical; }
  button { padding: 7px 14px; background: #1f2937; color: #fff; border: 0;
           border-radius: 6px; cursor: pointer; font-size: 13px; font-family: inherit; }
  button:hover { background: #374151; }
  .meta { color: #888; font-size: 12px; margin-top: 32px; }
  .note { color: #666; font-size: 12px; }
</style>
<h1>branchview</h1>
<p class="note">claude.ai conversation-branch visualizer — click any leaf to jump there.</p>

<h2>Option A — drag to bookmarks bar</h2>
<p>Drag this button up to your bookmarks bar:</p>
<a class="install" href="${safeUrlHref}">branchview</a>
<p class="note">Doesn't work in every browser. Recent Chrome may strip the
<code>javascript:</code> scheme during drag, leaving you with a broken bookmark
that searches Google when clicked. If that happens, use Option B.</p>

<h2>Option B — create the bookmark manually (always works)</h2>
<ol>
  <li>Right-click your bookmarks bar → <b>Add page…</b> (Chrome) or
      <b>Bookmark…</b> (Safari) or equivalent.</li>
  <li>Name it <b>branchview</b>.</li>
  <li>Paste the URL below into the URL field and save.</li>
</ol>
<p><button id="copy">Copy URL to clipboard</button>
   <span id="copy-status" class="note"></span></p>
<textarea id="url" readonly>${safeUrlText}</textarea>

<h2>Using it</h2>
<ol>
  <li>Open any chat at <code>claude.ai/chat/&lt;id&gt;</code>.</li>
  <li>Click the <b>branchview</b> bookmark.</li>
  <li>A modal opens with the full branch tree. Click a node to preview it;
      click <b>Jump to this branch</b> to make it the displayed leaf, or
      <b>Jump to latest</b> to go to the most recent message across all
      branches.</li>
</ol>

<p class="meta">URL size: ${url.length.toLocaleString()} bytes (browser ceiling ~${MAX_URL_BYTES.toLocaleString()}).</p>

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

  const sourceBytes = Buffer.byteLength(src, 'utf8');
  const minBytes = Buffer.byteLength(result.code, 'utf8');
  console.log(`source:    ${sourceBytes.toLocaleString()} bytes`);
  console.log(`minified:  ${minBytes.toLocaleString()} bytes (${(minBytes / sourceBytes * 100).toFixed(1)}% of source)`);
  console.log(`url:       ${url.length.toLocaleString()} bytes (${(url.length / MAX_URL_BYTES * 100).toFixed(1)}% of ${MAX_URL_BYTES.toLocaleString()})`);
  console.log(`wrote:     dist/bookmarklet.url, dist/install.html`);
})().catch((err) => {
  console.error('build failed:', err.message);
  process.exit(1);
});
