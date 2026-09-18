# STORE.md

Recon of https://demo.inelabteamdev.com, 2026-09-18. Everything below was read off the live site
or the frontend bundle at `/assets/index-B9UiQq4X.js`. Anything not confirmed is marked.

## Summary

Catalogue and product metadata come from plain JSON endpoints. The price does not. It sits behind
a WebAssembly proof-of-work challenge, a session exchange and a signed short-lived bearer token,
and the page gates the whole thing behind simulated mouse movement. We drive it with Playwright
and let the page solve its own challenge.

## Endpoints

Three appear as literals in the bundle:

```
GET /api/catalog?page={n}&pageSize={n}
GET /api/product/{id}
GET /api/layout
```

Three more are assembled at runtime from a string lookup table (`fetch(n(566)+n(536)+"ge")`), so
they never appear as literals and a naive grep for `api/` misses them entirely:

```
GET  /api/challenge
POST /api/session                 (GET returns not_found)
GET  /api/products/{id}/price     (note: productS, plural, unlike /api/product/{id})
```

### /api/catalog

Returns `{page, pageSize, pages, total, items[]}`. Item fields: `id`, `slug`, `name`, `brand`,
`category`, `sku`, `description`. No price, no stock.

- 1000 products, ids 1 to 1000.
- `pageSize` is capped server-side at 60 (asking for 1000 returns 60).
- **Item order is randomised on every request.** Two calls to `page=1` returned completely
  different ids. Paging 1..50 would duplicate and miss products.
- Consequence: build the catalogue by walking ids 1..1000 against `/api/product/{id}`, or page
  and upsert by id until 1000 distinct rows exist. Do not assume page coverage.

### /api/product/{id}

Keys: `id, slug, name, brand, category, sku, description, specs, reviews`. Confirmed with
`json.load(...).keys()`. No price field, no stock field.

- Unknown id returns `{"error":"not_found"}` with a real HTTP 404. Do not retry.
- **`/product/{id}` in the browser returns HTTP 200 even for a dead product**, and renders
  "Couldn't load this product: Error: product 404" client-side. Status code alone is not a
  validity check when fetching the HTML page.
- 8 sequential calls: all 200, 97ms to 110ms. The API itself is not the flaky part.

### /api/layout

Returns the selector map the page renders with.

```json
{"revision":625002,"variant":4,"validUntil":1789747297978,
 "classes":{"priceWrap":"pw-z6","priceValue":"pv-z6","mrp":"mr-z6","sale":"sl-z6",
            "badge":"bd-z6","rating":"rt-z6","seller":"sr-z6","delivery":"dl-z6","stock":"st-z6"},
 "order":["rating","seller","delivery","stock"],
 "priceTag":"span","priceCarrier":"text","ratingAria":true,"sellerTitle":false}
```

- Class names rotate. `validUntil` was roughly 2.2 hours ahead, close to the scrape interval.
- Stable within a window: two calls 10s apart returned an identical payload.
- `priceTag` is the element name to look for (`span` here, may vary).
- `priceCarrier` is `text` or `split`. See the split case below.
- Selectors must be built from this response at scrape time and cached until `validUntil`.
  Store `revision` and `variant` on every scrape row; a change in either is a structure change.

## The price challenge chain

Observed request order on a reveal: `challenge` -> `session` -> `price`. On a retry the chain
repeats from `session`.

### GET /api/challenge

```json
{"salt":"b28eb2eee0ede3d19327a630ed9ebf20",
 "ts":1789740369769,
 "difficulty":3,
 "csig":"7425383eb975d75d687c8a5999b55a5172ad9f65fca6b22a797819ee011a0652",
 "wasm":"AGFzbQEAAAABBgFgAX8BfwMCAQAHBQEBZgAAC..."}
```

`wasm` is a base64 WebAssembly module. Decoding the header: one type `(i32) -> (i32)`, one
function, exported as `f`. The body is a long chain of `i32.mul` / `i32.xor` against constants,
i.e. a hash mixer. `difficulty: 3` means a proof of work: find a nonce whose mixed output meets
a leading-zero style target.

The module is served fresh per request, so the hash function itself can change between calls.

### POST /api/session

Exchanges the solved challenge for a session token. Payload not captured (see Open questions).
The resulting token appears in the price bearer as a 24-hex string.

### GET /api/products/{id}/price

Requires `Authorization: Bearer <token>`. The token is `base64url(payload) + "." + hex64`:

```
GET|/api/products/647/price|647|cd41a7b145a9ee708fb3e4ca|1789739829549
 ^method ^path              ^id  ^session token           ^ms timestamp
```

followed by a 64-hex signature over that string.

Notably the payload contains **no mouse data**: no dwell, no move list, no `trusted` flag. The
interaction gate described below is enforced client-side only. The server checks the signature.

Replaying a captured token from curl a few minutes later returned `{"error":"unauthorized"}`
with HTTP 401, so the token is short-lived, single-use, or bound to the session.

**This endpoint is where the injected failures live.** An observed reveal produced a `price` call
returning **503** followed by a successful retry; the UI reported "Loaded in 2 attempts". The
catalog and product endpoints were clean across 8 sequential calls, so retry logic needs to
target this endpoint specifically.

## Why Playwright rather than reimplementing the chain

Reproducing this in Node is possible in principle: `WebAssembly.instantiate` works server-side,
so the PoW could be solved and the token signed directly, giving a pure-HTTP scraper. It was
rejected for this build:

- the signing routine is behind the same string-table obfuscation and would need full reversal
- the WASM is served per request and can change shape
- any change on their side breaks a reimplementation silently, while a browser just follows along
- the assignment permits a headless browser "where the page genuinely requires JavaScript
  rendering", and a WASM proof-of-work is exactly that

Playwright drives the page and lets it solve its own challenge. The trade-off is memory and run
time on a 512MB free instance, handled by scraping one product at a time with a shared browser
context.

## The price reveal (client-side gate)

`/product/{id}` renders a `div.price-block` whose state class is one of `price-idle`,
`price-loading`, `price-retrying`, `price-error`, `price-success`, plus the rotating
`classes.priceWrap`.

### Interaction gate (class `Ar`, constructed as `new Ar({minMoves:8, minDwellMs:600})`)

- `mousemove` events on the price block are throttled: one recorded per 40ms.
- `missing()` blocks until `moves.length >= 8` **and** `now - hoverAt >= 600ms`.
- The Reveal button is `disabled` while `missing()` is non-null.
- On click it snapshots `{hoverAt, dwellMs, moves[], clickAt, trusted}` where `trusted` is
  `event.nativeEvent.isTrusted`, and sends it with the quote request.
- A synthetic `page.click()` will not pass. Real `mouse.move()` steps are required: at least 8
  positions across the block, spaced over 40ms, then wait 600ms before clicking.

### Injected click failure (function `Xn`)

```js
if (Math.random() < .35) { if (Math.random() < .5) return; setTimeout(e, 900); return }
```

35% of clicks misbehave: half are dropped entirely (~17.5% of all clicks do nothing at all),
half fire 900ms late. The fix is to click again, not to re-request. Detect by watching for the
price block to leave `price-idle`.

### App-side retry

`jr = 6` attempts, backoff `300 * attempt`, states `retrying` then `error`. The UI itself shows
"Retrying (attempt n/6)". Our scraper should not exceed what the app will do on its own.

## Reading the price (the trap)

`price-success` contains three price-shaped nodes. Two are decoys.

| node | contents | use |
|---|---|---|
| `span.price-value[aria-hidden]`, `display:none` | `d1 = format(Br(shown))` | **wrong number** |
| `span.amount[data-price=true][aria-hidden]`, `display:none` | `d2 = format(Br(shown + 7))` | **wrong number** |
| element with class `layout.classes.mrp` | struck-through list price | not the answer |
| element with class `layout.classes.sale` | "Deal price ..." | not the answer |
| element with class `layout.classes.priceValue` | `h`, the real formatted price | **this one** |

Confirmed on product 647: mrp 45,813 struck through, "Deal price 34,818", and 23,823 rendered
large under `classes.priceValue`, with a "48% off" badge. 45,813 x 0.52 = 23,823, so the large
figure is the current selling price and "Deal price" is a third distractor alongside the two
hidden decoys.

```js
function Br(e){ let t = .6 + e % 37 / 37 * .7; return Math.max(1, Math.round(e * t)) }
```

The decoys are the true price scaled by 0.6 to 1.3, so they look completely plausible. The
obvious selectors (`.price-value`, `[data-price]`) return believable garbage. Never read them.
They are hidden, so a visibility check catches this too, but read the layout class directly.

`mrp` (struck through) and `sale` also render, under `classes.mrp` and `classes.sale`. The value
under `classes.priceValue` is the current selling price.

### Format variants (function `Ir`)

Base format is `Intl.NumberFormat('en-IN', {style:'currency', currency, maximumFractionDigits:0})`,
so Indian digit grouping (1,23,456) and a currency symbol.

| variant | transformation |
|---|---|
| `spaced` | commas replaced with spaces |
| `euro` | commas replaced with periods, `,00` appended |
| `trailing` | `/- (incl. of all taxes)` appended |
| `unicode` | every ASCII digit replaced with fullwidth (U+FF10..U+FF19) |
| `nbsp` | every character joined with NBSP (U+00A0) + zero-width space (U+200B) |
| `lakh` | `Rs.` + NBSP + `en-IN` with 2 decimals |

Parser requirements, in order: normalise fullwidth digits to ASCII, strip U+200B and U+00A0,
strip currency symbols and any trailing tax text, then handle both `,` and `.` and ` ` as
grouping separators. `parseFloat` on the raw string is wrong for at least four of the six
variants. Validate the result is a positive integer-ish number, then cross-check against the
previous recorded price.

### priceCarrier: "split"

When `layout.priceCarrier === 'split'`, each character is wrapped in its own `<span>` with a
zero-width space between (`function Lr`). Use `textContent` on the container, never `innerHTML`,
and strip U+200B before parsing.

## Stock

`m.stock` is an integer, rendered inside `classes.stock` through one of five random phrasings:

```
In stock · {n} left | Only {n} left | {n} in stock | Selling fast — {n} left | Hurry, just {n} left
```

Zero renders `<span class="stock-badge out-stock">Out of stock</span>`.

Parse the integer out of the text; do not match the sentence. Map to our enum: `0` →
`out_of_stock`, low threshold → `low_stock`, otherwise `in_stock`. Keep the raw string.

## Other observations

- A canvas fingerprint is computed (`fillText('INE store ✓ price ₹ 42.9')` then `toDataURL()`)
  plus an FNV-style string hash. Unconfirmed whether it gates the quote. A real Chromium passes
  it; this is another reason not to fake the interaction over HTTP.
- A cookie consent banner appears on first visit. Unconfirmed whether dismissing it is required
  before the price block is interactive. Dismiss it in the browser fetcher to be safe.
- Currency is INR throughout.
- The listing page carries no prices, only SKU and name.

## What this means for the build

1. **Catalogue**: plain HTTP, `/api/product/{id}` for ids 1..1000, cached in Postgres. Search
   runs locally with `ILIKE`, since the store has no search endpoint. Refresh rarely.
2. **Price scrape**: Playwright. Load `/product/{id}`, dismiss cookies, move the mouse across the
   price block in >= 8 steps at >= 40ms spacing, wait 600ms, click Reveal, wait for
   `price-success` or `price-error`. Re-click if the block stays `price-idle` past a timeout.
3. **Selectors**: fetched from `/api/layout`, cached until `validUntil`, never hardcoded.
4. **Extraction ladder** collapses to: layout map → element under `classes.priceValue` →
   normalise → validate. The decoy nodes are an explicit deny list.
5. HTTP-only fetching was tried first and ruled out by evidence, not assumed. That belongs in
   the design note.