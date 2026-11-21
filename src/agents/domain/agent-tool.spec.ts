import { DomainValidationError } from '../../shared/domain/errors.js';
import {
  AGENT_TOOLS_MAX,
  assertAgentTools,
  type AgentToolDef,
} from './agent-tool.js';

const schema = (properties: Record<string, unknown> = {}) => ({
  type: 'object',
  properties,
});

const tool = (over: Partial<AgentToolDef> = {}): AgentToolDef => ({
  name: 'mcp:github/create_issue',
  title: 'Create issue',
  description: 'Creates an issue.',
  inputSchema: schema(),
  category: 'mcp',
  ...over,
});

const invalidAt = (tools: unknown[], index: number) => {
  try {
    assertAgentTools(tools);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainValidationError);
    const e = error as DomainValidationError;
    expect(e.code).toBe('validation-failed');
    expect(e.details).toMatchObject({ index });
    return;
  }
  throw new Error('expected assertAgentTools to throw');
};

describe('assertAgentTools', () => {
  it('requires the prefix of the category', () => {
    expect(
      assertAgentTools([
        tool(),
        tool({
          name: 'browser:open',
          category: 'browser',
          inputSchema: schema({ url: { type: 'string' } }),
        }),
        tool({
          name: 'folder:read',
          category: 'folder',
          inputSchema: schema({ path: { type: 'string' } }),
        }),
        tool({
          name: 'folder:write',
          category: 'folder',
          inputSchema: schema({ path: { type: 'string' } }),
        }),
        tool({
          name: 'folder:list',
          category: 'folder',
          inputSchema: schema({ path: { type: 'string' } }),
        }),
      ]).map((t) => t.name),
    ).toEqual([
      'mcp:github/create_issue',
      'browser:open',
      'folder:read',
      'folder:write',
      'folder:list',
    ]);

    // the name does not follow the category
    invalidAt([tool({ category: 'browser' })], 0);
    // malformed names
    invalidAt([tool({ name: 'mcp:github' })], 0);
    invalidAt([tool({ name: 'mcp:/create' })], 0);
    invalidAt([tool({ name: 'mcp:github/' })], 0);
    invalidAt([tool({ name: 'github/create_issue' })], 0);
    invalidAt(
      [
        tool(),
        tool({
          name: 'folder:delete',
          category: 'folder',
          inputSchema: schema({ path: {} }),
        }),
      ],
      1,
    );
    invalidAt([tool({ name: 'browser:', category: 'browser' })], 0);
    // unknown category and non-object entries
    invalidAt([tool({ category: 'shell' as never })], 0);
    invalidAt([tool(), 'nope'], 1);
    invalidAt([tool({ title: '' })], 0);
  });

  it('requires inputSchema.properties.path on folder tools and .url on browser tools', () => {
    invalidAt(
      [
        tool({
          name: 'folder:read',
          category: 'folder',
          inputSchema: schema(),
        }),
      ],
      0,
    );
    invalidAt(
      [
        tool({
          name: 'folder:read',
          category: 'folder',
          inputSchema: schema({ url: {} }),
        }),
      ],
      0,
    );
    invalidAt(
      [
        tool({
          name: 'browser:open',
          category: 'browser',
          inputSchema: schema({ path: {} }),
        }),
      ],
      0,
    );
    invalidAt(
      [
        tool({
          name: 'browser:open',
          category: 'browser',
          inputSchema: {},
        }),
      ],
      0,
    );
    // an mcp tool needs neither
    expect(assertAgentTools([tool({ inputSchema: schema() })])).toHaveLength(1);
  });

  it('refuses more than 200 tools and duplicated names', () => {
    expect(AGENT_TOOLS_MAX).toBe(200);
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => tool({ name: `mcp:s/t${i}` }));
    expect(assertAgentTools(many(200))).toHaveLength(200);
    expect(() => assertAgentTools(many(201))).toThrow(DomainValidationError);
    invalidAt([tool(), tool({ title: 'Other' })], 1);
    expect(assertAgentTools([])).toEqual([]);
  });
});
