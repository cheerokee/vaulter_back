import { createHash } from 'node:crypto';
import {
  callEffect,
  toolEffect,
  type AgentRule,
} from '../../../agents/domain/agent-policy.js';
import type { AgentToolDef } from '../../../agents/domain/agent-tool.js';
import type { BrainToolCall } from '../../domain/brain-step.js';
import type { LlmTool, LlmToolCall } from '../ports/language-model.js';

// O que o modelo pode pedir ao PC (spec pc-agent §5.3 e §5.5): catálogo do agente ∩ ACL efetiva para o DONO, sem as
// negadas, e só quando o autor gravado da mensagem é o dono (quem decide isso é o compositor, pelo `AgentTurnView`,
// nunca o `history`). Cada chamada que o modelo devolve é conferida de novo: fora do que foi oferecido, ou negada pelo
// caminho/domínio do `input` (`callEffect`), ela é DESCARTADA (nunca sai em `toolCalls`, nunca com `effect: 'deny'`).

const SAFE_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * The name the model sees for a catalog tool. Catalog names carry `:` and `/` (`mcp:erp/consultar`), which the model
 * APIs refuse (Bedrock and OpenAI-style: `^[a-zA-Z0-9_-]{1,64}$`): every other character becomes `_` and a hash of the
 * real name is appended (deterministic, so the same tool keeps its name across steps; injective in practice). A name
 * that is already safe and has no `_` is kept as it is.
 */
export function llmToolName(name: string): string {
  if (SAFE_NAME.test(name) && !name.includes('_')) return name;
  const hash = createHash('sha256').update(name, 'utf8').digest('hex');
  return `${name.replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 55)}_${hash.slice(0, 8)}`;
}

/**
 * The catalog tools the model may call: by name, not `deny` for `userId`; none when PC tools are not allowed. Two
 * catalog tools that map to the same model-safe name (`llmToolName`) are BOTH left out (a call could not be told apart),
 * and so is a catalog tool whose model-safe name is `reserved` (the back's own tools of the step, e.g. the document
 * tools); `collisions` = how many tools were left out for that (the caller logs only the count).
 */
export function offeredDefs(
  catalog: readonly AgentToolDef[],
  rules: AgentRule[],
  userId: string,
  pcToolsAllowed: boolean,
  reserved: ReadonlySet<string> = new Set(),
): { offered: Map<string, AgentToolDef>; collisions: number } {
  const offered = new Map<string, AgentToolDef>();
  if (!pcToolsAllowed) return { offered, collisions: 0 };
  const byKey = new Map<string, AgentToolDef[]>();
  for (const def of catalog) {
    const key = llmToolName(def.name);
    byKey.set(key, [...(byKey.get(key) ?? []), def]);
  }
  let collisions = 0;
  for (const [key, defs] of byKey) {
    if (defs.length > 1 || reserved.has(key)) {
      collisions += defs.length;
      continue;
    }
    if (toolEffect(rules, userId, defs[0]!.name) !== 'deny') {
      offered.set(key, defs[0]!);
    }
  }
  return { offered, collisions };
}

/** The offered tools as the model sees them: the model-safe name, the catalog name in the description, the schema. */
export function toLlmTools(
  offered: ReadonlyMap<string, AgentToolDef>,
): LlmTool[] {
  return [...offered].map(([name, def]) => ({
    name,
    description: `${def.title} (${def.name}): ${def.description}`,
    inputSchema: def.inputSchema,
  }));
}

/** The tools offered to the model (spec §5.3 "Ferramentas oferecidas ao modelo"), with the model-safe names. */
export function offerTools(
  catalog: AgentToolDef[],
  rules: AgentRule[],
  userId: string,
  pcToolsAllowed: boolean,
): LlmTool[] {
  return toLlmTools(
    offeredDefs(catalog, rules, userId, pcToolsAllowed).offered,
  );
}

/**
 * The model's calls checked against what was offered (`offered`, keyed by the model-safe name): a call to a tool that
 * was not offered, or whose `path`/`url` makes it `deny` (`callEffect`), goes to `dropped`; the others come out with
 * the catalog name and their `effect` (`allow` or `confirm`).
 */
export function markCalls(
  calls: readonly LlmToolCall[],
  offered: ReadonlyMap<string, AgentToolDef>,
  rules: AgentRule[],
  userId: string,
): { out: BrainToolCall[]; dropped: LlmToolCall[] } {
  const out: BrainToolCall[] = [];
  const dropped: LlmToolCall[] = [];
  for (const call of calls) {
    const def = offered.get(call.name);
    const effect = def ? callEffect(rules, userId, def, call.input) : 'deny';
    if (!def || effect === 'deny') {
      dropped.push(call);
      continue;
    }
    out.push({ id: call.id, name: def.name, input: call.input, effect });
  }
  return { out, dropped };
}
