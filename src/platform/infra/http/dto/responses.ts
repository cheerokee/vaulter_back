import type { PlatformMeView } from '../../../application/get-platform-me.use-case.js';
import type { StaffMemberView } from '../../../application/list-staff.use-case.js';

export function platformMeResponse(v: PlatformMeView) {
  return { roles: v.roles, permissions: v.permissions };
}

export function staffMemberResponse(v: StaffMemberView) {
  return { userId: v.userId, name: v.name, email: v.email, roles: v.roles };
}
