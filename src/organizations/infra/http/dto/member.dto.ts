import { IsIn } from 'class-validator';
import { ORG_ROLE_KEYS, type OrgRoleKey } from '../../../domain/membership.js';

export class ChangeMemberRoleDto {
  @IsIn(ORG_ROLE_KEYS)
  roleKey!: OrgRoleKey;
}
