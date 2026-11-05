/**
 * PII redaction. Firecrawl gates this behind its paid tiers; here it is just a
 * flag. Everything is replaced with a typed placeholder so the model can still
 * reason about the shape of the data without seeing the values.
 */
export type PiiKind = 'email' | 'phone' | 'card' | 'ssn' | 'iban' | 'ip' | 'aadhaar' | 'pan';

export interface RedactionReport {
  text: string;
  counts: Partial<Record<PiiKind, number>>;
  total: number;
}

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE = /(?:(?:\+|00)\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3,5}[\s.-]?\d{3,4}[\s.-]?\d{0,4}\b/g;
const CARD = /\b(?:\d[ -]*?){13,19}\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const AADHAAR = /\b[2-9]\d{3}\s?\d{4}\s?\d{4}\b/g;
const PAN = /\b[A-Z]{5}\d{4}[A-Z]\b/g;

/** Card numbers must pass Luhn, otherwise every long order number gets masked. */
function luhnValid(digits: string): boolean {
  const n = digits.replace(/\D/g, '');
  if (n.length < 13 || n.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = n.length - 1; i >= 0; i--) {
    let d = n.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function redactPii(input: string, kinds?: PiiKind[]): RedactionReport {
  const enabled = new Set<PiiKind>(
    kinds ?? ['email', 'phone', 'card', 'ssn', 'iban', 'aadhaar', 'pan'],
  );
  const counts: Partial<Record<PiiKind, number>> = {};
  let text = input;

  const apply = (kind: PiiKind, re: RegExp, validate?: (m: string) => boolean) => {
    if (!enabled.has(kind)) return;
    text = text.replace(re, (match) => {
      if (validate && !validate(match)) return match;
      counts[kind] = (counts[kind] ?? 0) + 1;
      return `[REDACTED_${kind.toUpperCase()}]`;
    });
  };

  // Order matters: cards and IBANs before the loose phone pattern.
  apply('email', EMAIL);
  apply('card', CARD, luhnValid);
  apply('iban', IBAN);
  apply('ssn', SSN);
  apply('aadhaar', AADHAAR, (m) => luhnVerhoeffish(m));
  apply('pan', PAN);
  apply('ip', IPV4);
  apply('phone', PHONE, (m) => (m.replace(/\D/g, '').length >= 9 ? true : false));

  const total = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
  return { text, counts, total };
}

/** Aadhaar uses the Verhoeff checksum; a cheap length+prefix check avoids false hits. */
function luhnVerhoeffish(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  return digits.length === 12 && digits[0] >= '2';
}

export function redactDeep<T>(value: T, kinds?: PiiKind[]): T {
  if (typeof value === 'string') return redactPii(value, kinds).text as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, kinds)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, kinds);
    }
    return out as unknown as T;
  }
  return value;
}
