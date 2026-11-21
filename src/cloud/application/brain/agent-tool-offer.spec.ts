import type { AgentRule } from '../../../agents/domain/agent-policy.js';
import type { AgentToolDef } from '../../../agents/domain/agent-tool.js';
import {
  llmToolName,
  markCalls,
  offerTools,
  offeredDefs,
} from './agent-tool-offer.js';

const OWNER = '01900000-0000-7000-8000-000000000001';

const tool = (
  name: string,
  category: AgentToolDef['category'],
  property?: string,
): AgentToolDef => ({
  name,
  title: `Title of ${name}`,
  description: `Does ${name}.`,
  inputSchema: {
    type: 'object',
    properties: property ? { [property]: { type: 'string' } } : {},
  },
  category,
});

const catalog: AgentToolDef[] = [
  tool('mcp:erp/consultar', 'mcp'),
  tool('mcp:erp/apagar', 'mcp'),
  tool('folder:write', 'folder', 'path'),
  tool('browser:open', 'browser', 'url'),
];

const rule = (
  resource: AgentRule['resource'],
  effect: AgentRule['effect'],
): AgentRule => ({ subject: { kind: 'all' }, resource, effect });

const rules: AgentRule[] = [
  rule({ kind: 'tool', pattern: 'mcp:erp/*' }, 'allow'),
  rule({ kind: 'tool', pattern: 'mcp:erp/apagar' }, 'deny'),
  rule({ kind: 'tool', pattern: 'folder:write' }, 'confirm'),
  rule({ kind: 'folder', path: 'docs/' }, 'allow'),
  rule({ kind: 'folder', path: 'docs/secreto/' }, 'deny'),
  // browser:open has no tool rule: deny
  rule({ kind: 'domain', host: 'erp.empresa.com' }, 'allow'),
];

const offeredMap = (offered: { name: string }[]) =>
  new Map(
    catalog
      .filter((t) => offered.some((o) => o.name === llmToolName(t.name)))
      .map((t) => [llmToolName(t.name), t] as const),
  );

describe('agent tool offer (spec pc-agent §5.3, §5.5)', () => {
  it('deny tools are never offered', () => {
    const offered = offerTools(catalog, rules, OWNER, true);
    expect(offered.map((t) => t.name)).toEqual([
      llmToolName('mcp:erp/consultar'),
      llmToolName('folder:write'),
    ]);
    // No rule at all = deny: nothing offered.
    expect(offerTools(catalog, [], OWNER, true)).toEqual([]);
  });

  it("nothing from the pc is offered when the question's author is not the hub owner", () => {
    expect(offerTools(catalog, rules, OWNER, false)).toEqual([]);
  });

  it('offers the schema of the tool and a model-safe name', () => {
    const [consultar] = offerTools(catalog, rules, OWNER, true);
    expect(consultar).toEqual({
      name: llmToolName('mcp:erp/consultar'),
      description: expect.stringContaining('mcp:erp/consultar'),
      inputSchema: catalog[0]!.inputSchema,
    });
    for (const name of [
      'mcp:erp/consultar',
      'folder:write',
      `mcp:x/${'a'.repeat(190)}`,
    ]) {
      expect(llmToolName(name)).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
    expect(llmToolName('mcp:a/b')).not.toBe(llmToolName('mcp:a_b'));
    expect(llmToolName('mcp:erp/consultar')).toBe(
      llmToolName('mcp:erp/consultar'),
    );
  });

  it('markCalls drops calls to tools that were not offered and marks the effect of the others', () => {
    const offered = offeredMap(offerTools(catalog, rules, OWNER, true));
    const calls = [
      { id: 'c1', name: llmToolName('mcp:erp/consultar'), input: { n: 1 } },
      // denied by name (never offered)
      { id: 'c2', name: llmToolName('mcp:erp/apagar'), input: {} },
      // hallucinated
      { id: 'c3', name: 'shell_exec', input: { cmd: 'rm -rf /' } },
      // the raw catalog name is not what was offered
      { id: 'c4', name: 'mcp:erp/consultar', input: {} },
      // offered, path allowed: the most restrictive (tool confirm, path allow) = confirm
      {
        id: 'c5',
        name: llmToolName('folder:write'),
        input: { path: 'docs/a.md' },
      },
      // offered, but the path is denied: dropped, never `effect: 'deny'`
      {
        id: 'c6',
        name: llmToolName('folder:write'),
        input: { path: 'docs/secreto/b.md' },
      },
      // offered, path missing: deny = dropped
      { id: 'c7', name: llmToolName('folder:write'), input: {} },
    ];
    const { out, dropped } = markCalls(calls, offered, rules, OWNER);
    expect(out).toEqual([
      { id: 'c1', name: 'mcp:erp/consultar', input: { n: 1 }, effect: 'allow' },
      {
        id: 'c5',
        name: 'folder:write',
        input: { path: 'docs/a.md' },
        effect: 'confirm',
      },
    ]);
    expect(dropped.map((c) => c.id)).toEqual(['c2', 'c3', 'c4', 'c6', 'c7']);
  });

  it('markCalls with nothing offered drops everything', () => {
    const { out, dropped } = markCalls(
      [{ id: 'c1', name: llmToolName('mcp:erp/consultar'), input: {} }],
      new Map(),
      rules,
      OWNER,
    );
    expect(out).toEqual([]);
    expect(dropped).toHaveLength(1);
  });

  it('two catalog tools with the same model-safe name are neither offered (only the count reported)', () => {
    // A real 8-hex collision of the hash, with the same sanitized prefix (found offline).
    const a = tool('mcp:s/,..,,.,....,,.,,,,,,', 'mcp');
    const b = tool('mcp:s/.,,,...,,.,......,,,', 'mcp');
    expect(llmToolName(a.name)).toBe(llmToolName(b.name));
    const everything = [rule({ kind: 'tool', pattern: 'mcp:*' }, 'allow')];
    const { offered, collisions } = offeredDefs(
      [catalog[0]!, a, b],
      everything,
      OWNER,
      true,
    );
    expect([...offered.values()].map((d) => d.name)).toEqual([
      'mcp:erp/consultar',
    ]);
    expect(collisions).toBe(2);
    expect(
      offerTools([a, b], everything, OWNER, true).map((t) => t.name),
    ).toEqual([]);
  });
});
