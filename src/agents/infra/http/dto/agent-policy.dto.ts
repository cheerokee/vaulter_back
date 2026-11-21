import { IsArray, IsInt, Min } from 'class-validator';

// Só o formato da borda: cada regra é validada pelo domínio (`parseAgentRules`, 422 `agent-policy-invalid` com os
// índices). `baseVersion` 0 = ainda não há política.
export class ReplaceAgentPolicyDto {
  @IsInt()
  @Min(0)
  baseVersion!: number;

  @IsArray()
  rules!: unknown[];
}
