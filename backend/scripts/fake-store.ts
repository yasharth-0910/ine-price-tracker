// Local stand-in for demo.inelabteamdev.com, used by verify-scrape.ts.
//
// It serves the parts of the store the *price path* touches, and only those:
//   GET  /api/layout                 the rotating selector map (classes.priceValue is the real one)
//   GET  /api/challenge              trivial PoW stub (difficulty 0 — no real WASM here)
//   POST /api/session                trivial token stub
//   GET  /api/products/:id/price     the quote gate — this is the request verify-scrape faults
//   GET  /product/:id                the HTML page with the interaction gate + the decoy trap
//
// Network-level faults (503, 404, slow, timeout) are injected by verify-scrape with Playwright's
// route interception on the price request, NOT here. What lives here is the page *behaviour* the
// scraper has to survive, toggled per-request via query params on /product/:id:
//   ?price=N   the real price to render (default 23823)
//   ?drop=1    the first Reveal click is silently swallowed (mimics STORE.md's `Xn`); re-click works
//   ?missing=1 the element carrying classes.priceValue is absent      -> parse_empty
//   ?na=1      that element renders the text "N/A"                     -> parse_invalid
//   ?late=1    price-success is rendered ~1.2s after the price returns -> late render
//   ?notfound=1  the "product 404" page: no price block, no reveal, no price request (like /product/1001)
//
// The block and button expose only the handles the real store exposes — class .price-block and a
// button named "Reveal price", no ids — so a fetcher fitted to invented ids fails here, not in prod.
//
// The page deliberately does NOT reproduce the store's own client-side jr=6 retry: one Reveal click
// makes exactly one price request, so an injected route fault maps 1:1 to one observed attempt and
// the core's retry ladder is what's under test.
// ponytail: stdlib http, one HTML string, no express — a single fake page needs no framework.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';

// One window's worth of the rotating layout. classes.priceValue ('pv-z6') is the only real one;
// `.price-value` and `[data-price]` in the page are the display:none decoys STORE.md warns about.
export const FAKE_LAYOUT = {
  revision: 625002,
  variant: 4,
  validUntil: Date.now() + 2 * 3600 * 1000,
  classes: {
    priceWrap: 'pw-z6', priceValue: 'pv-z6', mrp: 'mr-z6', sale: 'sl-z6',
    badge: 'bd-z6', rating: 'rt-z6', seller: 'sr-z6', delivery: 'dl-z6', stock: 'st-z6',
  },
  order: ['rating', 'seller', 'delivery', 'stock'],
  priceTag: 'span',
  priceCarrier: 'text' as const,
  ratingAria: true,
  sellerTitle: false,
};

function pageHtml(layout: typeof FAKE_LAYOUT): string {
  const c = layout.classes;
  return `<!doctype html><html><head><meta charset="utf-8"><title>fake product</title></head>
<body>
<div class="price-block price-idle ${c.priceWrap}">
  <button disabled aria-label="Reveal price">Reveal price</button>
  <div id="slot"></div>
</div>
<script>
(function () {
  var Q = new URLSearchParams(location.search);
  var faults = { drop: Q.has('drop'), missing: Q.has('missing'), na: Q.has('na'), late: Q.has('late') };
  var PRICE = Number(Q.get('price') || '23823');
  var ID = location.pathname.split('/').filter(Boolean).pop();

  // Located the way the real store forces you to: by class and by the button, not by invented ids.
  var pb = document.querySelector('.price-block');
  var btn = pb.querySelector('button');

  // Interaction gate: >= 8 throttled mouse moves (1 per 40ms) AND >= 600ms dwell since first move,
  // then a *trusted* click. Mirrors STORE.md's Ar({minMoves:8, minDwellMs:600}).
  var moves = 0, hoverAt = null, lastMove = 0;
  pb.addEventListener('mousemove', function () {
    var now = performance.now();
    if (hoverAt === null) hoverAt = now;
    if (now - lastMove < 40) return; // throttle: at most one recorded per 40ms
    lastMove = now;
    moves++;
    update();
  });
  function blocked() {
    if (moves < 8) return 'moves';
    if (hoverAt === null || performance.now() - hoverAt < 600) return 'dwell';
    return null;
  }
  function update() { btn.disabled = blocked() !== null; }
  setInterval(update, 50); // re-check so dwell can elapse after the mouse stops moving

  function setState(s) { pb.className = 'price-block ' + s + ' ${c.priceWrap}'; }

  var dropped = false;
  btn.addEventListener('click', function (e) {
    if (blocked() !== null) return;               // gate not satisfied
    if (!e.isTrusted) return;                      // synthetic dispatch is rejected
    if (faults.drop && !dropped) { dropped = true; return; } // Xn: swallow the first click, stay idle
    setState('price-loading');                     // leaving price-idle is how a re-click is detected
    reveal();
  });

  function reveal() {
    // Observed store order: challenge -> session -> price. The price call is the one that gets faulted.
    fetch('/api/challenge?id=' + ID)
      .then(function () { return fetch('/api/session', { method: 'POST' }); })
      .then(function () { return fetch('/api/products/' + ID + '/price'); })
      .then(function (r) {
        if (!r.ok) { setState('price-error'); return; } // 5xx/404 -> error state, carries the status
        var render = function () { renderPrice(); setState('price-success'); };
        if (faults.late) setTimeout(render, 1200); else render();
      })
      .catch(function () { setState('price-error'); }); // aborted/timed-out request
  }

  function fmt(n) {
    return new Intl.NumberFormat('en-IN',
      { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n);
  }
  // The decoy scaler from STORE.md: true price * (0.6 .. 1.3). Plausible and wrong.
  function Br(e) { var t = 0.6 + (e % 37) / 37 * 0.7; return Math.max(1, Math.round(e * t)); }

  function renderPrice() {
    var realText = faults.na ? 'N/A' : fmt(PRICE);
    var priceValueEl = faults.missing ? '' : '<span class="${c.priceValue}">' + realText + '</span>';
    document.getElementById('slot').innerHTML =
      priceValueEl +
      '<span class="price-value" aria-hidden="true" style="display:none">' + fmt(Br(PRICE)) + '</span>' +
      '<span class="amount" data-price="true" aria-hidden="true" style="display:none">' + fmt(Br(PRICE + 7)) + '</span>' +
      '<span class="${c.mrp}" style="text-decoration:line-through">' + fmt(Math.round(PRICE * 1.9)) + '</span>' +
      '<span class="${c.sale}">Deal price ' + fmt(Math.round(PRICE * 0.9)) + '</span>' +
      '<span class="${c.stock}">In stock \\u00b7 7 left</span>';
  }
})();
</script>
</body></html>`;
}

// The store's "gone product" page (like /product/1001): a React error state, no price block, no
// reveal button, so the reveal flow never starts and no price request is ever made.
function notFoundHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>fake product</title></head>
<body><div id="root"><p class="load-error">Couldn't load this product: Error: product 404</p></div></body></html>`;
}

export interface FakeStore {
  url: string;
  close: () => Promise<void>;
}

export function startFakeStore(layout = FAKE_LAYOUT): Promise<FakeStore> {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost');
    const p = u.pathname;
    const json = (code: number, obj: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (p === '/api/layout') return json(200, layout);
    if (p === '/api/challenge') return json(200, { salt: 'x', ts: Date.now(), difficulty: 0, csig: 'x', wasm: '' });
    if (p === '/api/session') return json(200, { token: 'deadbeefdeadbeefdeadbeef' });
    if (/^\/api\/products\/[^/]+\/price$/.test(p)) return json(200, { ok: true });
    if (/^\/product\/[^/]+$/.test(p)) {
      res.writeHead(200, { 'content-type': 'text/html' });
      // Not-found page mirrors the real store: no price block, no reveal button, no price request.
      return res.end(u.searchParams.has('notfound') ? notFoundHtml() : pageHtml(layout));
    }
    json(404, { error: 'not_found' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// Run standalone for eyeballing the page: `npx tsx scripts/fake-store.ts`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startFakeStore().then((s) => {
    console.log(`fake store on ${s.url}  (try ${s.url}/product/647?price=23823)`);
  });
}
