# NOTES

Running log of things that went wrong on the first attempt. The design note in the submission is
built from this file, so write entries as they happen. Reconstructing them on Sunday produces
something that reads fake, because it is.

Format:

```
## [phase] short title
**What it did:** the wrong version, with the actual code or behaviour
**Why it was wrong:** the failure it would have caused in production
**How it was caught:** verify harness / real run / reading the code
**Fix:** what changed
```

Worth capturing when it happens: selectors invented instead of read from the real DOM, retry
wrapped around the wrong layer so parse failures never retried, price parsed with `parseFloat` on
a string containing a currency symbol or comma, failures written to history as null or 0, cron
handler doing work before responding and timing out, a "success" logged when the page returned 200
with an empty product body.

---
