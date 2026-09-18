// Turn the raw price text into a number, parsing deliberately so a dropped currency symbol or
// thousands separator can never silently change the value. Handles the format variants the store
// rotates through: fullwidth digits, zero-width spaces (U+200B), non-breaking spaces (U+00A0),
// space- and euro-style separators, trailing tax text, Indian lakh grouping/words, and the split
// carrier (digits glued from fragments). Throws ScrapeError('parse_invalid') when no real price
// is present (e.g. "N/A"); callers treat a missing element as parse_empty before ever calling in.
import { fileURLToPath } from 'node:url';
import { ScrapeError } from '../errors.js';

const ZERO_WIDTH = /[​‌‍﻿]/g;

export function parsePrice(input: string | null | undefined): number {
  if (input == null) throw new ScrapeError('parse_invalid', 'null price');

  // NFKC folds fullwidth digits/punctuation to ASCII and non-breaking spaces to normal spaces.
  const s = input.normalize('NFKC').replace(ZERO_WIDTH, '').trim();
  if (!s) throw new ScrapeError('parse_invalid', 'empty price');

  // Indian magnitude words multiply the base figure ("2.5 lakh" -> 250000).
  let multiplier = 1;
  const lower = s.toLowerCase();
  if (/\bcrores?\b|\bcr\b/.test(lower)) multiplier = 1e7;
  else if (/\blakhs?\b|\blacs?\b/.test(lower)) multiplier = 1e5;

  // Pull out number-like tokens (digits with , . or internal spaces) and keep the one with the most
  // digits — that's the price, not a stray "1" in "incl. 1 tax" or a decoy count.
  const tokens = (s.match(/\d[\d.,\s]*\d|\d/g) ?? []).map((t) => t.replace(/\s/g, ''));
  if (tokens.length === 0) throw new ScrapeError('parse_invalid', `no digits in "${input}"`);
  const token = tokens.reduce((best, t) => (digitCount(t) >= digitCount(best) ? t : best));

  const value = resolveSeparators(token) * multiplier;
  if (!Number.isFinite(value)) throw new ScrapeError('parse_invalid', `not finite from "${input}"`);
  return value;
}

const digitCount = (t: string) => (t.match(/\d/g) ?? []).length;

// Decide which of `,` / `.` is the decimal point and which is grouping, then produce a JS number.
function resolveSeparators(num: string): number {
  const hasComma = num.includes(',');
  const hasDot = num.includes('.');

  if (hasComma && hasDot) {
    // Whichever appears last is the decimal separator; the other is grouping.
    const decimalSep = num.lastIndexOf(',') > num.lastIndexOf('.') ? ',' : '.';
    const groupSep = decimalSep === ',' ? '.' : ',';
    num = num.split(groupSep).join('').replace(decimalSep, '.');
  } else if (hasComma) {
    num = resolveSingle(num, ',');
  } else if (hasDot) {
    num = resolveSingle(num, '.');
  }
  return Number(num);
}

// One separator kind present. Multiple of them => all grouping (1,23,823 or 23.823.000). A single
// one is grouping when it splits off exactly 3 digits (23,823), otherwise a decimal (19.99 / 23,5).
function resolveSingle(num: string, sep: string): string {
  const parts = num.split(sep);
  if (parts.length > 2) return parts.join('');
  const [head, tail] = parts as [string, string];
  if (tail.length === 3) return head + tail; // grouping
  if (tail.length === 1 || tail.length === 2) return head + '.' + tail; // decimal
  return head + tail;
}

// --- self-check: the six format variants (+ the split carrier feeding a glued string). ---
function demo(): void {
  const eq = (raw: string, want: number) => {
    const got = parsePrice(raw);
    if (got !== want) throw new Error(`parsePrice(${JSON.stringify(raw)}) = ${got}, want ${want}`);
  };
  eq('２３８２３', 23823); // fullwidth digits
  eq('23​823', 23823); // zero-width space inside the number
  eq('₹23 823', 23823); // non-breaking space grouping
  eq('23 823', 23823); // space grouping
  eq('23.823,00', 23823); // euro separators (dot group, comma decimal)
  eq('23.823', 23823); // euro grouping, no decimals
  eq('₹23,823', 23823); // plain INR grouping
  eq('₹23,823 incl. of all taxes', 23823); // trailing tax text
  eq('Rs. 23,823', 23823); // currency prefix with its own dot
  eq('₹1,23,823', 123823); // lakh grouping
  eq('2.5 lakh', 250000); // lakh word multiplier
  eq('19.99', 19.99); // genuine decimal
  for (const bad of ['N/A', 'Price on request', '', '   ', 'sold out']) {
    let threw = false;
    try {
      parsePrice(bad);
    } catch (e) {
      threw = e instanceof ScrapeError && e.code === 'parse_invalid';
    }
    if (!threw) throw new Error(`parsePrice(${JSON.stringify(bad)}) should throw parse_invalid`);
  }
  console.log('parsePrice: all format variants OK');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) demo();
