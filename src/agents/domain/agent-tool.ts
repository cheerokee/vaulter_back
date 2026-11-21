import { DomainValidationError } from '../../shared/domain/errors.js';

export type AgentToolCategory = 'mcp' | 'browser' | 'folder';

export const AGENT_TOOL_CATEGORIES: readonly AgentToolCategory[] = [
  'mcp',
  'browser',
  'folder',
];

/** A tool the agent (a `pc` hub) knows how to run. Software metadata, not customer content. */
export type AgentToolDef = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  category: AgentToolCategory;
};

/** Spec pc-agent §5.4: at most 200 tools per agent. */
export const AGENT_TOOLS_MAX = 200;
export const AGENT_TOOL_NAME_MAX = 200;
export const AGENT_TOOL_TITLE_MAX = 200;
export const AGENT_TOOL_DESCRIPTION_MAX = 2000;
/** Serialized `inputSchema` (UTF-16 units of the JSON text). */
export const AGENT_TOOL_SCHEMA_MAX = 8192;

// mcp:<server>/<tool>, browser:<action>, folder:<read|write|list>
const NAME_PATTERNS: Record<AgentToolCategory, RegExp> = {
  mcp: /^mcp:[^\s/:]+\/\S+$/,
  browser: /^browser:[A-Za-z0-9_.-]+$/,
  folder: /^folder:(read|write|list)$/,
};

/** Parameter the schema must declare, by category (the policy matches paths and URLs against the rules). */
const REQUIRED_PROPERTY: Partial<Record<AgentToolCategory, string>> = {
  browser: 'url',
  folder: 'path',
};

const invalid = (index: number | null, detail: string) =>
  new DomainValidationError(
    'validation-failed',
    index === null ? detail : `tools[${index}]: ${detail}`,
    index === null ? undefined : { index },
  );

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function text(raw: unknown, field: string, max: number, index: number) {
  if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > max) {
    throw invalid(index, `${field} must be a text of 1 to ${max} characters.`);
  }
  return raw;
}

/**
 * Validates the catalog the agent publishes (`PUT /hub/agent/tools`) and returns it typed. 422 `validation-failed`
 * with the `index` of the first invalid entry (the message never repeats the content).
 */
export function assertAgentTools(tools: unknown[]): AgentToolDef[] {
  if (!Array.isArray(tools)) throw invalid(null, 'tools must be a list.');
  if (tools.length > AGENT_TOOLS_MAX) {
    throw invalid(null, `At most ${AGENT_TOOLS_MAX} tools are accepted.`);
  }
  const seen = new Set<string>();
  return tools.map((raw, index) => {
    if (!isRecord(raw)) throw invalid(index, 'must be an object.');
    const category = raw.category;
    if (!AGENT_TOOL_CATEGORIES.includes(category as AgentToolCategory)) {
      throw invalid(index, 'category must be mcp, browser or folder.');
    }
    const cat = category as AgentToolCategory;
    const name = text(raw.name, 'name', AGENT_TOOL_NAME_MAX, index);
    if (!NAME_PATTERNS[cat].test(name)) {
      throw invalid(index, `name does not follow the ${cat} naming.`);
    }
    if (seen.has(name)) throw invalid(index, 'name is duplicated.');
    seen.add(name);
    const title = text(raw.title, 'title', AGENT_TOOL_TITLE_MAX, index);
    const description = text(
      raw.description,
      'description',
      AGENT_TOOL_DESCRIPTION_MAX,
      index,
    );
    const inputSchema = raw.inputSchema;
    if (!isRecord(inputSchema)) {
      throw invalid(index, 'inputSchema must be an object.');
    }
    if (JSON.stringify(inputSchema).length > AGENT_TOOL_SCHEMA_MAX) {
      throw invalid(index, 'inputSchema is too large.');
    }
    const required = REQUIRED_PROPERTY[cat];
    if (required) {
      const properties = inputSchema.properties;
      if (!isRecord(properties) || !isRecord(properties[required])) {
        throw invalid(
          index,
          `inputSchema.properties.${required} is required on ${cat} tools.`,
        );
      }
    }
    return { name, title, description, inputSchema, category: cat };
  });
}
