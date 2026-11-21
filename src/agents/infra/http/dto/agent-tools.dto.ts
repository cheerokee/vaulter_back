import { IsArray } from 'class-validator';
import type {
  AgentToolCategory,
  AgentToolDef,
} from '../../../domain/agent-tool.js';

// Só o formato da borda (uma lista): cada ferramenta é validada pelo domínio (`assertAgentTools`, 422 com o índice).
export class PublishAgentToolsDto {
  @IsArray()
  tools!: unknown[];
}

export const agentToolResponse = (t: AgentToolDef) => ({
  name: t.name,
  title: t.title,
  description: t.description,
  inputSchema: t.inputSchema,
  category: t.category satisfies AgentToolCategory,
});
