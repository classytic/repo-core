/**
 * ReDoS assessment for a user-supplied regex — the ONE analyser every parser uses.
 *
 * STRUCTURAL, not a regex over the regex: the pattern is walked token by token with a group stack,
 * so nesting is seen however it is spelled. A pattern is unsafe when:
 *   - a group REPEATED by `*`, `+` or `{n,}` / `{n,m}` (m > 1) contains a repetition or an
 *     alternation — `(a+)+`, `(a*)*`, `(.*)*`, `(a|aa)+`, `((ab)*)+` (exponential backtracking);
 *   - it uses a backreference (`\1`, `\k<name>`) — matching becomes NP-hard;
 *   - it carries more than {@link MAX_UNBOUNDED_QUANTIFIERS} unbounded quantifiers
 *     (`.*.*.*…` — polynomial, but degree grows with each);
 *   - it exceeds the complexity budget: more than 8 groups, more than 10 alternations, or
 *     unbounded quantifiers × groups above 40 (`(a*)(b+)(c*)…` — dense, overlapping, polynomial);
 *   - it is not valid syntax.
 * Conservative on purpose: `(foo|bar)+` is refused too. A user regex runs on a shared database;
 * refusing a rare legitimate pattern costs a 400, accepting a hostile one costs the server.
 */

export const MAX_UNBOUNDED_QUANTIFIERS = 20;

export type RegexRisk =
  | { readonly safe: true }
  | {
      readonly safe: false;
      readonly reason:
        | 'nested-quantifier'
        | 'backreference'
        | 'too-many-quantifiers'
        | 'too-complex'
        | 'invalid'
        | 'too-long';
    };

interface Frame {
  /** The group's body contains a repetition (directly or in a nested group). */
  repeats: boolean;
  /** The group's body contains a top-level `|`. */
  alternates: boolean;
}

/**
 * The quantifier token at `i`: its length, whether it repeats (max > 1), whether the count is
 * VARIABLE (min ≠ max — the source of backtracking ambiguity; `{2}` is not) and whether it is unbounded.
 */
function readQuantifier(
  p: string,
  i: number,
): { length: number; repeats: boolean; variable: boolean; unbounded: boolean } | null {
  const c = p[i];
  if (c === '*' || c === '+') return { length: 1, repeats: true, variable: true, unbounded: true };
  if (c === '?') return { length: 1, repeats: false, variable: true, unbounded: false };
  if (c !== '{') return null;
  const m = /^\{(\d+)(,(\d*))?\}/.exec(p.slice(i));
  if (!m) return null;
  const min = Number(m[1]);
  const hasComma = m[2] !== undefined;
  const max = hasComma ? (m[3] === '' ? Number.POSITIVE_INFINITY : Number(m[3])) : min;
  return {
    length: m[0].length,
    repeats: max > 1,
    variable: min !== max,
    unbounded: max === Number.POSITIVE_INFINITY,
  };
}

export function assessRegex(pattern: string, options: { maxLength?: number } = {}): RegexRisk {
  if (options.maxLength !== undefined && pattern.length > options.maxLength) {
    return { safe: false, reason: 'too-long' };
  }
  try {
    new RegExp(pattern);
  } catch {
    return { safe: false, reason: 'invalid' };
  }

  const stack: Frame[] = [{ repeats: false, alternates: false }];
  /** The group that just closed — the atom a following quantifier applies to. */
  let closedGroup: Frame | null = null;
  let unbounded = 0;
  let groups = 0;
  let alternations = 0;

  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    const top = stack[stack.length - 1] as Frame;

    if (c === '\\') {
      const next = pattern[i + 1] ?? '';
      if (/[1-9]/.test(next) || next === 'k') return { safe: false, reason: 'backreference' };
      i += 1;
      closedGroup = null;
      continue;
    }
    if (c === '[') {
      // A character class is ONE atom; skip to its closing bracket (escapes respected).
      let j = i + 1;
      if (pattern[j] === '^') j++;
      if (pattern[j] === ']') j++;
      while (j < pattern.length && pattern[j] !== ']') j += pattern[j] === '\\' ? 2 : 1;
      i = j;
      closedGroup = null;
      continue;
    }
    if (c === '(') {
      groups += 1;
      stack.push({ repeats: false, alternates: false });
      // Skip the group-kind prefix (`?:`, `?=`, `?!`, `?<=`, `?<!`, `?<name>`) — it is not a quantifier.
      if (pattern[i + 1] === '?') {
        const kind = /^\?(?:[:=!]|<[=!]|<[A-Za-z_][A-Za-z0-9_]*>)/.exec(pattern.slice(i + 1));
        if (kind) i += kind[0].length;
      }
      closedGroup = null;
      continue;
    }
    if (c === ')') {
      const frame = stack.pop() as Frame;
      const parent = stack[stack.length - 1] as Frame;
      // A repetition inside a group is a repetition inside its parent too.
      if (frame.repeats) parent.repeats = true;
      closedGroup = frame;
      continue;
    }
    if (c === '|') {
      alternations += 1;
      top.alternates = true;
      closedGroup = null;
      continue;
    }
    const q = readQuantifier(pattern, i);
    if (q) {
      if (q.unbounded) unbounded += 1;
      if (q.repeats) {
        if (closedGroup && (closedGroup.repeats || closedGroup.alternates)) {
          return { safe: false, reason: 'nested-quantifier' };
        }
      }
      // Only a VARIABLE count makes the enclosing group ambiguous — `(a{2})+` is `(aa)+`.
      if (q.repeats && q.variable) top.repeats = true;
      i += q.length - 1;
      // A lazy (`?`) or possessive (`+`) suffix belongs to this quantifier.
      if (pattern[i + 1] === '?' || pattern[i + 1] === '+') i += 1;
      closedGroup = null;
      continue;
    }
    closedGroup = null;
  }

  if (unbounded > MAX_UNBOUNDED_QUANTIFIERS) return { safe: false, reason: 'too-many-quantifiers' };
  if (groups > 8 || alternations > 10 || unbounded * groups > 40) {
    return { safe: false, reason: 'too-complex' };
  }
  return { safe: true };
}

/** Escape every regex metacharacter — the literal-match fallback for an unsafe pattern. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
