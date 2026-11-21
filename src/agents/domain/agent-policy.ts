import { DomainValidationError } from '../../shared/domain/errors.js';
import type { AgentToolDef } from './agent-tool.js';

/**
 * Pure ACL evaluation (spec pc-agent §5.5). Fail closed: anything missing, unparseable or ambiguous is `deny`, and
 * no matching rule is `deny`. The agent runs the same logic locally; the local policy has the last word.
 */

export type AgentEffect = 'allow' | 'confirm' | 'deny';
export type AgentRuleSubject =
  { kind: 'all' } | { kind: 'user'; userId: string };
export type AgentRuleResource =
  | { kind: 'tool'; pattern: string }
  | { kind: 'folder'; path: string }
  | { kind: 'domain'; host: string };
export type AgentRule = {
  subject: AgentRuleSubject;
  resource: AgentRuleResource;
  effect: AgentEffect;
};

/** Spec pc-agent §5.5: at most 500 rules per policy. */
export const AGENT_POLICY_MAX_RULES = 500;
const TOOL_PATTERN_MAX = 200;
const PATH_MAX = 1024;
const USER_ID_MAX = 128;

const RESTRICTIVENESS: Record<AgentEffect, number> = {
  allow: 0,
  confirm: 1,
  deny: 2,
};
const EFFECTS = Object.keys(RESTRICTIVENESS);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const mostRestrictive = (a: AgentEffect, b: AgentEffect): AgentEffect =>
  RESTRICTIVENESS[a] >= RESTRICTIVENESS[b] ? a : b;

/**
 * Case folding for the comparisons of `confirm` and `deny` rules (never `allow`). `toLowerCase` alone misses
 * folds that case-insensitive file systems apply (long s, dotless i, ligatures, Kelvin sign); upper then lower
 * catches them. Always applied to both sides, after NFC.
 */
const fold = (s: string) => s.toUpperCase().toLowerCase();

// ---------------------------------------------------------------- paths

/** Splits a normalized path into segments; '' (the released folder itself) has none. */
const segmentsOf = (path: string) => (path === '' ? [] : path.split('/'));

/**
 * Normalizes a path relative to the released folder: backslashes become `/`, `.` segments and duplicate slashes go
 * away, `a/../b` resolves to `b`. Returns `null` (invalid) for: non-text or empty input, absolute paths (leading `/`,
 * which also covers UNC), drive letters, anything with `..` escaping the folder, control characters, `:` anywhere and
 * segments Windows would silently rewrite (trailing dot or space), Windows wildcards (`* ? < > | "`) and 8.3
 * short-name aliases (`~1`). The text is NFC-normalized first. `.` alone is the released folder itself (`''`).
 */
export function normalizeAgentPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > PATH_MAX) {
    return null;
  }
  // NFC, so a decomposed (NFD) spelling cannot dodge a rule written composed, and the other way around
  const text = raw.normalize('NFC');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f:]/.test(text)) return null;
  const unified = text.replace(/\\/g, '/');
  if (unified.startsWith('/')) return null;
  const out: string[] = [];
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.pop() === undefined) return null;
      continue;
    }
    if (/[. ]$/.test(segment)) return null;
    // Windows wildcards and 8.3 short-name aliases (`SECRET~1`) would reach folders the rules name differently
    if (/[*?<>|"]/.test(segment) || /~\d+(\.|$)/.test(segment)) return null;
    out.push(segment);
  }
  return out.join('/');
}

type FolderRulePath = { segments: string[]; subtree: boolean };

/** Rule path: normalized like a call path; a trailing `/` (or `\`) makes it a subtree. */
function parseFolderRulePath(raw: unknown): FolderRulePath | null {
  const normalized = normalizeAgentPath(raw);
  if (normalized === null) return null;
  const subtree = /[\\/]$/.test(raw as string);
  return { segments: segmentsOf(normalized), subtree };
}

const canonicalFolderRulePath = ({ segments, subtree }: FolderRulePath) =>
  segments.length === 0
    ? subtree
      ? './'
      : '.'
    : segments.join('/') + (subtree ? '/' : '');

/**
 * Whether a folder rule covers the path. A subtree rule covers the folder itself and everything under it; a rule
 * without the slash covers that exact path. Case is exact only for `allow` rules; `confirm` and `deny` also match ignoring
 * case: on Windows and macOS `Secret/` and `secret/` are the same folder and a restriction must not be sidestepped.
 */
function folderRuleMatches(
  rule: FolderRulePath,
  effect: AgentEffect,
  path: string[],
): boolean {
  const same = (a: string, b: string) =>
    a === b || (effect !== 'allow' && fold(a) === fold(b));
  if (
    rule.subtree
      ? path.length < rule.segments.length
      : path.length !== rule.segments.length
  ) {
    return false;
  }
  return rule.segments.every((segment, i) => same(segment, path[i]));
}

// ---------------------------------------------------------------- hosts

const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

type HostRule = { base: string; wildcard: boolean };

/** `erp.empresa.com` or `*.empresa.com` (the wildcard needs at least two labels after it: no `*.com`). */
function parseHostRule(raw: unknown): HostRule | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 253) {
    return null;
  }
  const host = raw.toLowerCase();
  const wildcard = host.startsWith('*.');
  const base = wildcard ? host.slice(2) : host;
  const labels = base.split('.');
  if (!labels.every((l) => l.length <= 63 && LABEL.test(l))) return null;
  if (wildcard && labels.length < 2) return null;
  return { base, wildcard };
}

/** Host of a parsed http(s) URL, lowercased and without the root dot; `null` otherwise. */
function hostOfUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8192) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  return host.length > 0 ? host : null;
}

/** `*.empresa.com` matches subdomains at any depth, NOT the apex `empresa.com` (the spec is silent: fail closed). */
function hostRuleMatches(rule: HostRule, host: string): boolean {
  return rule.wildcard ? host.endsWith(`.${rule.base}`) : host === rule.base;
}

// ---------------------------------------------------------------- tools

/** Tool pattern: an exact name, or a prefix ended by `*` (the only wildcard; a lone `*` is every tool). */
function validToolPattern(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  if (raw.length > TOOL_PATTERN_MAX || /\s/.test(raw)) return false;
  const star = raw.indexOf('*');
  return star === -1 || star === raw.length - 1;
}

/** Exact for `allow`; `confirm` and `deny` also match ignoring case (same principle as folders). */
function toolPatternMatches(
  pattern: string,
  effect: AgentEffect,
  name: string,
) {
  if (effect !== 'allow') {
    pattern = fold(pattern);
    name = fold(name);
  }
  return pattern.endsWith('*')
    ? name.startsWith(pattern.slice(0, -1))
    : pattern === name;
}

// ---------------------------------------------------------------- parsing

const invalidPolicy = (invalidRules: number[], detail: string) =>
  new DomainValidationError('agent-policy-invalid', detail, { invalidRules });

function parseRule(raw: unknown): AgentRule | null {
  if (!isRecord(raw)) return null;
  if (
    Object.keys(raw).some((k) => !['subject', 'resource', 'effect'].includes(k))
  ) {
    return null;
  }
  const { subject, resource, effect } = raw;
  if (typeof effect !== 'string' || !EFFECTS.includes(effect)) return null;

  let parsedSubject: AgentRuleSubject;
  if (
    isRecord(subject) &&
    subject.kind === 'all' &&
    Object.keys(subject).length === 1
  ) {
    parsedSubject = { kind: 'all' };
  } else if (
    isRecord(subject) &&
    subject.kind === 'user' &&
    Object.keys(subject).length === 2 &&
    typeof subject.userId === 'string' &&
    subject.userId.length > 0 &&
    subject.userId.length <= USER_ID_MAX &&
    !/\s/.test(subject.userId)
  ) {
    parsedSubject = { kind: 'user', userId: subject.userId };
  } else {
    return null;
  }

  if (!isRecord(resource) || Object.keys(resource).length !== 2) return null;
  let parsedResource: AgentRuleResource;
  if (resource.kind === 'tool' && validToolPattern(resource.pattern)) {
    parsedResource = { kind: 'tool', pattern: resource.pattern };
  } else if (resource.kind === 'folder') {
    const path = parseFolderRulePath(resource.path);
    if (!path) return null;
    parsedResource = { kind: 'folder', path: canonicalFolderRulePath(path) };
  } else if (resource.kind === 'domain') {
    const host = parseHostRule(resource.host);
    if (!host) return null;
    parsedResource = {
      kind: 'domain',
      host: host.wildcard ? `*.${host.base}` : host.base,
    };
  } else {
    return null;
  }
  return {
    subject: parsedSubject,
    resource: parsedResource,
    effect: effect as AgentEffect,
  };
}

/**
 * Validates and canonicalizes the rules of a policy. 422 `agent-policy-invalid` with `details.invalidRules` = the
 * indexes of ALL invalid rules (or `[]` when the list itself is wrong). The message never repeats rule content.
 */
export function parseAgentRules(raw: unknown): AgentRule[] {
  if (!Array.isArray(raw)) {
    throw invalidPolicy([], 'rules must be a list.');
  }
  if (raw.length > AGENT_POLICY_MAX_RULES) {
    throw invalidPolicy(
      [],
      `At most ${AGENT_POLICY_MAX_RULES} rules are accepted.`,
    );
  }
  const rules: AgentRule[] = [];
  const invalidRules: number[] = [];
  raw.forEach((item, index) => {
    const rule = parseRule(item);
    if (rule) rules.push(rule);
    else invalidRules.push(index);
  });
  if (invalidRules.length > 0) {
    throw invalidPolicy(invalidRules, 'Some rules are invalid.');
  }
  return rules;
}

// ---------------------------------------------------------------- evaluation

/** Only the rules that apply to the person: `all` and `user:<userId>`. */
export function rulesFor(rules: AgentRule[], userId: string): AgentRule[] {
  return rules.filter(
    (r) =>
      isRecord(r) &&
      isRecord(r.subject) &&
      (r.subject.kind === 'all' ||
        (r.subject.kind === 'user' && r.subject.userId === userId)),
  );
}

/**
 * The applicable rules, re-validated (rules may not have gone through `parseAgentRules`). `null` when anything
 * unreadable is found (unknown effect, bad pattern, bad path, malformed subject): the caller denies.
 */
function scoped(rules: AgentRule[], userId: string): AgentRule[] | null {
  if (!Array.isArray(rules)) return null;
  const out: AgentRule[] = [];
  for (const raw of rules as unknown[]) {
    if (!isRecord(raw) || !isRecord(raw.subject)) return null;
    const rule = parseRule(raw);
    if (rule === null) return null;
    if (
      rule.subject.kind === 'all' ||
      (rule.subject.kind === 'user' && rule.subject.userId === userId)
    ) {
      out.push(rule);
    }
  }
  return out;
}

type Candidate = { effect: AgentEffect; specificity: number; user: boolean };

/**
 * Picks the effect among the rules that matched: a person rule beats an `all` rule (before specificity), then the
 * most specific wins, then a tie goes to the most restrictive. No candidate = `deny`.
 */
function decide(candidates: Candidate[]): AgentEffect {
  if (candidates.length === 0) return 'deny';
  const pool = candidates.some((c) => c.user)
    ? candidates.filter((c) => c.user)
    : candidates;
  const top = Math.max(...pool.map((c) => c.specificity));
  return pool
    .filter((c) => c.specificity === top)
    .map((c) => c.effect)
    .reduce(mostRestrictive);
}

const isUserRule = (r: AgentRule) => r.subject.kind === 'user';

/** Effect of the tool by its name alone (what the back uses to offer the tool to the model). */
export function toolEffect(
  rules: AgentRule[],
  userId: string,
  toolName: string,
): AgentEffect {
  const applicable = scoped(rules, userId);
  if (applicable === null) return 'deny';
  const candidates: Candidate[] = [];
  for (const rule of applicable) {
    const res = rule.resource;
    if (
      res.kind !== 'tool' ||
      !toolPatternMatches(res.pattern, rule.effect, toolName)
    ) {
      continue;
    }
    candidates.push({
      effect: rule.effect,
      user: isUserRule(rule),
      // exact name beats any prefix; a longer prefix beats a shorter one
      specificity: res.pattern.endsWith('*')
        ? res.pattern.length - 1
        : Number.MAX_SAFE_INTEGER,
    });
  }
  return decide(candidates);
}

function pathEffect(rules: AgentRule[], userId: string, input: unknown) {
  if (!isRecord(input)) return 'deny';
  const normalized = normalizeAgentPath(input.path);
  if (normalized === null) return 'deny';
  const path = segmentsOf(normalized);
  const applicable = scoped(rules, userId);
  if (applicable === null) return 'deny';
  const candidates: Candidate[] = [];
  for (const rule of applicable) {
    if (rule.resource.kind !== 'folder') continue;
    const parsed = parseFolderRulePath(rule.resource.path);
    if (!parsed || !folderRuleMatches(parsed, rule.effect, path)) continue;
    candidates.push({
      effect: rule.effect,
      user: isUserRule(rule),
      // more segments first; at the same depth the exact path beats the subtree
      specificity: parsed.segments.length * 2 + (parsed.subtree ? 0 : 1),
    });
  }
  return decide(candidates);
}

function domainEffect(rules: AgentRule[], userId: string, input: unknown) {
  if (!isRecord(input)) return 'deny';
  const host = hostOfUrl(input.url);
  if (host === null) return 'deny';
  const applicable = scoped(rules, userId);
  if (applicable === null) return 'deny';
  const candidates: Candidate[] = [];
  for (const rule of applicable) {
    if (rule.resource.kind !== 'domain') continue;
    const parsed = parseHostRule(rule.resource.host);
    if (!parsed || !hostRuleMatches(parsed, host)) continue;
    candidates.push({
      effect: rule.effect,
      user: isUserRule(rule),
      // exact host beats any wildcard; a wildcard with more labels beats one with fewer
      specificity: parsed.wildcard
        ? parsed.base.split('.').length
        : Number.MAX_SAFE_INTEGER,
    });
  }
  return decide(candidates);
}

/**
 * Effect of one call. `folder:*` tools also need the path rule and `browser:*` tools the domain rule: the most
 * restrictive between the tool rule and the resource rule wins, and a missing or malformed `path`/`url` is `deny`.
 * MCP tools are evaluated by name only.
 */
export function callEffect(
  rules: AgentRule[],
  userId: string,
  tool: AgentToolDef,
  input: unknown,
): AgentEffect {
  const byName = toolEffect(rules, userId, tool.name);
  switch (tool.category) {
    case 'mcp':
      return byName;
    case 'folder':
      return mostRestrictive(byName, pathEffect(rules, userId, input));
    case 'browser':
      return mostRestrictive(byName, domainEffect(rules, userId, input));
    default:
      return 'deny';
  }
}
