/**
 * AMQP topic-exchange matching. Routing keys and patterns are dot-separated words;
 * in a pattern `*` matches exactly one word and `#` matches zero or more words.
 */
export function matchesPattern(pattern: string, routingKey: string): boolean {
  const p = pattern.split('.');
  const k = routingKey.split('.');
  // memoised recursion over (pattern index, key index); patterns are short, so this is cheap.
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    const key = i * (k.length + 1) + j;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let r: boolean;
    if (i === p.length) r = j === k.length;
    else if (p[i] === '#') r = go(i + 1, j) || (j < k.length && go(i, j + 1));
    else if (j === k.length) r = false;
    else r = (p[i] === '*' || p[i] === k[j]) && go(i + 1, j + 1);
    memo.set(key, r);
    return r;
  };
  return go(0, 0);
}

const WORD = /^[a-z0-9_-]+$/;
const PATTERN_WORD = /^([a-z0-9_-]+|\*|#)$/;

/** True for a valid concrete routing key (no wildcards, no placeholders). */
export function isRoutingKey(s: string): boolean {
  return s.length > 0 && s.split('.').every((w) => WORD.test(w));
}

/** True for a valid subscription pattern (`*`, `#`, literal words). */
export function isPattern(s: string): boolean {
  return s.length > 0 && s.split('.').every((w) => PATTERN_WORD.test(w));
}

/** `block.indexed.{network}` → `block.indexed.*` (the AMQP binding key for a topic template). */
export function templateToPattern(template: string): string {
  return template.replace(/\{[a-zA-Z][a-zA-Z0-9_]*\}/g, '*');
}
