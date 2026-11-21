import { DomainValidationError } from '../../shared/domain/errors.js';
import {
  callEffect,
  normalizeAgentPath,
  parseAgentRules,
  rulesFor,
  toolEffect,
  type AgentEffect,
  type AgentRule,
  type AgentRuleResource,
  type AgentRuleSubject,
} from './agent-policy.js';
import type { AgentToolDef } from './agent-tool.js';

const U = 'user-1';
const all: AgentRuleSubject = { kind: 'all' };
const user = (userId = U): AgentRuleSubject => ({ kind: 'user', userId });
const rule = (
  subject: AgentRuleSubject,
  resource: AgentRuleResource,
  effect: AgentEffect,
): AgentRule => ({ subject, resource, effect });
const tool = (pattern: string): AgentRuleResource => ({
  kind: 'tool',
  pattern,
});
const folder = (path: string): AgentRuleResource => ({ kind: 'folder', path });
const domain = (host: string): AgentRuleResource => ({ kind: 'domain', host });

const def = (
  name: string,
  category: AgentToolDef['category'],
): AgentToolDef => ({
  name,
  title: name,
  description: name,
  inputSchema: {},
  category,
});
const read = def('folder:read', 'folder');
const open = def('browser:open', 'browser');
const mcp = def('mcp:erp/lancar', 'mcp');

describe('agent policy', () => {
  it('no rule means deny', () => {
    expect(toolEffect([], U, 'mcp:erp/lancar')).toBe('deny');
    expect(callEffect([], U, mcp, {})).toBe('deny');
  });

  it('a user rule beats an all rule, even when less restrictive', () => {
    const rules = [
      rule(all, tool('mcp:erp/lancar'), 'deny'),
      rule(user(), tool('mcp:erp/*'), 'allow'),
    ];
    expect(toolEffect(rules, U, 'mcp:erp/lancar')).toBe('allow');
    expect(toolEffect(rules, 'other', 'mcp:erp/lancar')).toBe('deny');
    // someone else's rule never applies
    expect(
      toolEffect([rule(user('x'), tool('*'), 'allow')], U, 'mcp:erp/lancar'),
    ).toBe('deny');
  });

  it('within the same subject the more specific wins', () => {
    const t = [
      rule(all, tool('mcp:erp/*'), 'deny'),
      rule(all, tool('mcp:erp/lancar'), 'allow'),
      rule(all, tool('mcp:*'), 'deny'),
    ];
    expect(toolEffect(t, U, 'mcp:erp/lancar')).toBe('allow');
    expect(toolEffect(t, U, 'mcp:erp/outra')).toBe('deny');
    const longer = [
      rule(all, tool('mcp:*'), 'deny'),
      rule(all, tool('mcp:erp/*'), 'confirm'),
    ];
    expect(toolEffect(longer, U, 'mcp:erp/x')).toBe('confirm');

    const f = [
      rule(all, tool('folder:*'), 'allow'),
      rule(all, folder('a/'), 'deny'),
      rule(all, folder('a/b/'), 'allow'),
      rule(all, folder('a/b/c.txt'), 'confirm'),
    ];
    expect(callEffect(f, U, read, { path: 'a/b/x' })).toBe('allow');
    expect(callEffect(f, U, read, { path: 'a/z' })).toBe('deny');
    expect(callEffect(f, U, read, { path: 'a/b/c.txt' })).toBe('confirm');

    const d = [
      rule(all, tool('browser:*'), 'allow'),
      rule(all, domain('*.empresa.com'), 'deny'),
      rule(all, domain('x.empresa.com'), 'allow'),
      rule(all, domain('*.y.empresa.com'), 'confirm'),
    ];
    expect(callEffect(d, U, open, { url: 'https://x.empresa.com/p' })).toBe(
      'allow',
    );
    expect(callEffect(d, U, open, { url: 'https://z.empresa.com/' })).toBe(
      'deny',
    );
    expect(callEffect(d, U, open, { url: 'https://a.y.empresa.com/' })).toBe(
      'confirm',
    );
  });

  it('a tie goes to the most restrictive', () => {
    const t = [
      rule(all, tool('mcp:erp/lancar'), 'allow'),
      rule(all, tool('mcp:erp/lancar'), 'confirm'),
    ];
    expect(toolEffect(t, U, 'mcp:erp/lancar')).toBe('confirm');
    expect(toolEffect([...t].reverse(), U, 'mcp:erp/lancar')).toBe('confirm');
    expect(
      toolEffect(
        [...t, rule(all, tool('mcp:erp/lancar'), 'deny')],
        U,
        'mcp:erp/lancar',
      ),
    ).toBe('deny');
  });

  it('folder and domain rules apply only to folder and browser tools', () => {
    const rules = [
      rule(all, tool('*'), 'allow'),
      rule(all, folder('a/'), 'deny'),
      rule(all, domain('*.empresa.com'), 'deny'),
    ];
    expect(
      callEffect(rules, U, mcp, { path: 'a/x', url: 'https://x.empresa.com' }),
    ).toBe('allow');
    // and a folder tool is not judged by a domain rule
    expect(
      callEffect(
        [rule(all, tool('*'), 'allow'), rule(all, domain('x.com'), 'allow')],
        U,
        read,
        { path: 'a' },
      ),
    ).toBe('deny');
  });

  it('callEffect takes the most restrictive between the tool rule and the path or domain rule', () => {
    const f = (toolE: AgentEffect, pathE: AgentEffect) => [
      rule(all, tool('folder:*'), toolE),
      rule(all, folder('docs/'), pathE),
    ];
    expect(callEffect(f('allow', 'confirm'), U, read, { path: 'docs/a' })).toBe(
      'confirm',
    );
    expect(callEffect(f('confirm', 'allow'), U, read, { path: 'docs/a' })).toBe(
      'confirm',
    );
    expect(callEffect(f('allow', 'deny'), U, read, { path: 'docs/a' })).toBe(
      'deny',
    );
    expect(callEffect(f('allow', 'allow'), U, read, { path: 'docs/a' })).toBe(
      'allow',
    );
    expect(callEffect(f('allow', 'allow'), U, read, { path: 'other/a' })).toBe(
      'deny',
    );
    const d = [
      rule(all, tool('browser:*'), 'confirm'),
      rule(all, domain('erp.empresa.com'), 'allow'),
    ];
    expect(callEffect(d, U, open, { url: 'https://erp.empresa.com/' })).toBe(
      'confirm',
    );
  });

  it('a missing or malformed path or url is deny', () => {
    const rules = [
      rule(all, tool('*'), 'allow'),
      rule(all, folder('./'), 'allow'),
      rule(all, domain('*.empresa.com'), 'allow'),
    ];
    expect(callEffect(rules, U, read, { path: 'ok/x' })).toBe('allow');
    for (const input of [
      undefined,
      null,
      'a',
      {},
      { path: 1 },
      { path: '' },
      { path: '../x' },
      { path: '/abs' },
      { path: 'C:\\x' },
      { path: 'c:/x' },
      { path: '\\\\srv\\share\\x' },
      { path: 'a/../../b' },
      { path: 'a\\..\\..\\b' },
      { path: 'a/b..' },
      { path: 'a\0b' },
    ]) {
      expect(callEffect(rules, U, read, input)).toBe('deny');
    }
    expect(callEffect(rules, U, open, { url: 'https://x.empresa.com/' })).toBe(
      'allow',
    );
    for (const input of [
      undefined,
      {},
      { url: 5 },
      { url: '' },
      { url: 'x.empresa.com' },
      { url: 'ftp://x.empresa.com/' },
      { url: 'file:///etc/passwd' },
      { url: 'javascript:alert(1)' },
      { url: 'https://empresa.com/' }, // apex is not a subdomain
      { url: 'https://evil.com/?h=x.empresa.com' },
      { url: 'https://x.empresa.com@evil.com/' },
      { url: 'https://x.empresa.com.evil.com/' },
      { url: 'https://evilempresa.com/' },
    ]) {
      expect(callEffect(rules, U, open, input)).toBe('deny');
    }
  });

  it('domain matching ignores case and the root dot, and a wildcard matches any depth but not the apex', () => {
    const rules = [
      rule(all, tool('browser:*'), 'allow'),
      rule(all, domain('*.Empresa.com'), 'allow'),
    ];
    expect(
      callEffect(rules, U, open, { url: 'HTTPS://ERP.EMPRESA.COM/x' }),
    ).toBe('allow');
    expect(
      callEffect(rules, U, open, { url: 'https://a.b.empresa.com./' }),
    ).toBe('allow');
    expect(callEffect(rules, U, open, { url: 'https://empresa.com/' })).toBe(
      'deny',
    );
  });

  it('subtree rules cover the folder itself; exact rules only that path; deny ignores case', () => {
    const rules = [
      rule(all, tool('folder:*'), 'allow'),
      rule(all, folder('a/'), 'allow'),
      rule(all, folder('b'), 'allow'),
      rule(all, folder('Secret/'), 'deny'),
    ];
    expect(callEffect(rules, U, read, { path: 'a' })).toBe('allow');
    expect(callEffect(rules, U, read, { path: './a//x\\y' })).toBe('allow');
    expect(callEffect(rules, U, read, { path: 'b' })).toBe('allow');
    expect(callEffect(rules, U, read, { path: 'b/c' })).toBe('deny');
    expect(callEffect(rules, U, read, { path: 'ab' })).toBe('deny');
    expect(callEffect(rules, U, read, { path: 'secret/k' })).toBe('deny');
    expect(callEffect(rules, U, read, { path: 'A/x' })).toBe('deny'); // allow is case-exact
    expect(callEffect(rules, U, read, { path: 'x/../a/y' })).toBe('allow');
  });

  it('confirm and deny match case variants; only allow is case-exact', () => {
    const rules = [
      rule(all, tool('*'), 'allow'),
      rule(all, folder('./'), 'allow'),
      rule(all, folder('Docs/Private/'), 'confirm'),
    ];
    expect(callEffect(rules, U, read, { path: 'docs/private/x' })).toBe(
      'confirm',
    );
    expect(
      toolEffect(
        [
          rule(all, tool('*'), 'allow'),
          rule(all, tool('mcp:ERP/*'), 'confirm'),
        ],
        U,
        'mcp:erp/x',
      ),
    ).toBe('confirm');
  });

  it('unicode case folding: restrictive rules match long s, dotless i and ligatures', () => {
    const base = [
      rule(all, tool('*'), 'allow'),
      rule(all, folder('./'), 'allow'),
    ];
    const cases: [string, AgentEffect, string, AgentEffect][] = [
      ['secret/', 'deny', '\u017fecret/x', 'deny'],
      ['Secret/', 'deny', '\u017fecret/x', 'deny'],
      ['office/', 'deny', 'o\ufb03ce/x', 'deny'],
      ['admin/', 'confirm', 'adm\u0131n/x', 'confirm'],
      ['k/', 'deny', '\u212a/x', 'deny'],
    ];
    for (const [ruleName, effect, path, expected] of cases) {
      const rules = [...base, rule(all, folder(ruleName), effect)];
      expect(callEffect(rules, U, read, { path })).toBe(expected);
    }
    // allow stays case-exact
    expect(
      callEffect(
        [...base.slice(0, 1), rule(all, folder('secret/'), 'allow')],
        U,
        read,
        {
          path: '\u017fecret/x',
        },
      ),
    ).toBe('deny');
  });

  it('sigma and NFC in tool patterns: restrictive rules cannot be dodged', () => {
    const allowAll = rule(all, tool('mcp:*'), 'allow');
    const cases: [string, string][] = [
      ['mcp:x\u03c3*', 'mcp:x\u03c3a'],
      ['mcp:X\u03a3*', 'mcp:x\u03c3a'],
      ['mcp:\u03c3*', 'mcp:\u03c3a'],
      ['mcp:caf\u00e9/*', 'mcp:cafe\u0301/x'], // NFD name vs NFC pattern
      ['mcp:cafe\u0301/*', 'mcp:caf\u00e9/x'], // NFC name vs NFD pattern
    ];
    for (const [pattern, name] of cases) {
      expect(
        toolEffect([allowAll, rule(all, tool(pattern), 'deny')], U, name),
      ).toBe('deny');
    }
    // exact (non-prefix) pattern too
    expect(
      toolEffect(
        [allowAll, rule(all, tool('mcp:caf\u00e9'), 'deny')],
        U,
        'mcp:cafe\u0301',
      ),
    ).toBe('deny');
  });

  it('sigma and final sigma fold equally in folder rules', () => {
    const base = [
      rule(all, tool('*'), 'allow'),
      rule(all, folder('./'), 'allow'),
    ];
    for (const [ruleName, path] of [
      [
        '\u03a3\u03bf\u03c6\u03af\u03b1\u03c3/',
        '\u03c3\u03bf\u03c6\u03af\u03b1\u03c3/x',
      ],
      [
        '\u03c3\u03bf\u03c6\u03af\u03b1\u03c2/',
        '\u03a3\u039f\u03a6\u038a\u0391\u03a3/x',
      ],
      ['\u03bf\u03c3/', '\u039f\u03c2/x'],
    ]) {
      const rules = [...base, rule(all, folder(ruleName), 'deny')];
      expect(callEffect(rules, U, read, { path })).toBe('deny');
    }
  });

  it('unicode: NFD and NFC spellings are the same path, in both directions', () => {
    const nfc = 'Relat\u00f3rios';
    const nfd = 'Relato\u0301rios';
    const base = [
      rule(all, tool('*'), 'allow'),
      rule(all, folder('./'), 'allow'),
    ];
    for (const [ruleName, callName] of [
      [nfc, nfd],
      [nfd, nfc],
    ]) {
      const rules = [...base, rule(all, folder(`${ruleName}/`), 'deny')];
      expect(callEffect(rules, U, read, { path: `${callName}/x` })).toBe(
        'deny',
      );
    }
    expect(normalizeAgentPath(nfd)).toBe(nfc);
  });

  it('unvalidated rules fail closed', () => {
    const base = [
      rule(all, tool('*'), 'allow'),
      rule(all, folder('./'), 'allow'),
    ];
    const bad = [
      rule(all, folder('/secret/'), 'deny'),
      rule(all, tool('a*b'), 'allow'),
      {
        subject: all,
        resource: tool('*'),
        effect: 'Deny',
      } as unknown as AgentRule,
      {
        subject: { kind: 'x' },
        resource: tool('*'),
        effect: 'allow',
      } as unknown as AgentRule,
      {
        subject: user('o'),
        resource: tool('*'),
        effect: 'Deny',
      } as unknown as AgentRule,
      null as unknown as AgentRule,
    ];
    for (const b of bad) {
      expect(callEffect([...base, b], U, read, { path: 'secret/x' })).toBe(
        'deny',
      );
      expect(toolEffect([...base, b], U, 'mcp:erp/x')).toBe('deny');
      expect(callEffect([...base, b], U, open, { url: 'https://x.com/' })).toBe(
        'deny',
      );
    }
  });

  it('windows wildcards and 8.3 aliases are invalid paths', () => {
    const rules = [
      rule(all, tool('*'), 'allow'),
      rule(all, folder('./'), 'allow'),
      rule(all, folder('Secret Folder/'), 'deny'),
    ];
    for (const path of [
      'SECRET~1/x',
      'Secret*/x',
      'a?/x',
      'a<b',
      'a|b',
      'a"b',
      'DOCUME~12.TXT',
    ]) {
      expect(normalizeAgentPath(path)).toBeNull();
      expect(callEffect(rules, U, read, { path })).toBe('deny');
    }
    expect(normalizeAgentPath('a~b/c~d.txt')).toBe('a~b/c~d.txt');
  });

  it('normalizeAgentPath turns backslashes into slashes and removes ./ and duplicate slashes', () => {
    expect(normalizeAgentPath('a\\b\\c.txt')).toBe('a/b/c.txt');
    expect(normalizeAgentPath('./a//b/./c')).toBe('a/b/c');
    expect(normalizeAgentPath('a/b/')).toBe('a/b');
    expect(normalizeAgentPath('a/../b')).toBe('b');
    expect(normalizeAgentPath('.')).toBe('');
    for (const bad of [
      '',
      '..',
      '../x',
      '/abs',
      'C:\\x',
      '//srv/x',
      'a/../../b',
      7,
      null,
      undefined,
    ]) {
      expect(normalizeAgentPath(bad)).toBeNull();
    }
  });

  it('rulesFor keeps only all and the person', () => {
    const rules = [
      rule(all, tool('a'), 'allow'),
      rule(user(), tool('b'), 'allow'),
      rule(user('other'), tool('c'), 'allow'),
    ];
    expect(
      rulesFor(rules, U).map(
        (r) => (r.resource as { pattern: string }).pattern,
      ),
    ).toEqual(['a', 'b']);
  });

  describe('parseAgentRules', () => {
    const good = {
      subject: { kind: 'all' },
      resource: { kind: 'tool', pattern: 'mcp:erp/*' },
      effect: 'allow',
    };

    it('canonicalizes valid rules', () => {
      expect(
        parseAgentRules([
          good,
          {
            subject: { kind: 'user', userId: U },
            resource: { kind: 'folder', path: '.\\docs\\\\a\\' },
            effect: 'confirm',
          },
          {
            subject: { kind: 'all' },
            resource: { kind: 'domain', host: '*.Empresa.COM' },
            effect: 'deny',
          },
        ]),
      ).toEqual([
        good,
        rule(user(), folder('docs/a/'), 'confirm'),
        rule(all, domain('*.empresa.com'), 'deny'),
      ]);
    });

    it('reports the indexes of all invalid rules', () => {
      const bad = [
        { ...good, effect: 'maybe' },
        good,
        { ...good, resource: { kind: 'folder', path: '../x' } },
        { ...good, resource: { kind: 'folder', path: '/abs' } },
        { ...good, resource: { kind: 'domain', host: '*.com' } },
        { ...good, resource: { kind: 'domain', host: 'https://x.com' } },
        { ...good, resource: { kind: 'tool', pattern: 'a*b' } },
        { ...good, subject: { kind: 'user' } },
        { ...good, extra: 1 },
        'x',
        null,
      ];
      let error: unknown;
      try {
        parseAgentRules(bad);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(DomainValidationError);
      expect(error).toMatchObject({
        code: 'agent-policy-invalid',
        details: { invalidRules: [0, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
      });
      expect((error as Error).message).not.toContain('../x');
    });

    it('accepts 500 rules and refuses 501 or a non-list', () => {
      expect(
        parseAgentRules(Array.from({ length: 500 }, () => good)),
      ).toHaveLength(500);
      for (const raw of [
        Array.from({ length: 501 }, () => good),
        {},
        null,
        'x',
      ]) {
        expect(() => parseAgentRules(raw)).toThrow(
          expect.objectContaining({
            code: 'agent-policy-invalid',
            details: { invalidRules: [] },
          }),
        );
      }
    });
  });
});
