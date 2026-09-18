# NOTES

Running log of things that went wrong on the first attempt. The design note in the submission is
built from this file, so write entries as they happen. Reconstructing them on Sunday produces
something that reads fake, because it is.

Format:

```
## [phase 0] Concluded there was no price endpoint
**What it did:** grepped the bundle for "/api/" literals, found exactly three endpoints,
and concluded the price was computed client-side.
**Why it was wrong:** three more endpoints are assembled from a string lookup table
(fetch(n(566)+n(536)+"ge") = /api/challenge) and never appear as literals.
**How it was caught:** clicking Reveal price with the Network tab open showed
challenge -> session -> price.
**Fix:** treat a literal grep as a lower bound on endpoints, not a complete list.

## [phase 0] The obvious price selector returns a wrong number
**What it did:** .price-value and [data-price] are present in the DOM and contain
plausible prices.
**Why it was wrong:** both are display:none decoys holding format(Br(shown)) where
Br scales the true price by 0.6 to 1.3. Wrong by up to 30% with no visible symptom.
**How it was caught:** reading the bundle, then confirming on product 647
(45,813 struck, 23,823 real, 48% off checks out).
**Fix:** read only the element carrying layout.classes.priceValue.
```

Worth capturing when it happens: selectors invented instead of read from the real DOM, retry
wrapped around the wrong layer so parse failures never retried, price parsed with `parseFloat` on
a string containing a currency symbol or comma, failures written to history as null or 0, cron
handler doing work before responding and timing out, a "success" logged when the page returned 200
with an empty product body.

---
