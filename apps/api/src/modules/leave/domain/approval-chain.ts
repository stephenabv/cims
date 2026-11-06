export type StepKind = 'SUPERVISOR' | 'DEPARTMENT_HEAD' | 'ROLE' | 'EMPLOYEE';

export interface ChainStep {
  kind: StepKind;
  roleId: string | null;
  employeeId: string | null;
}

export interface Applicant {
  employeeId: string;
  supervisorId: string | null;
  departmentHeadId: string | null;
}

export type ResolvedStep =
  | {
      kind: StepKind;
      status: 'ACTIVE';
      approverEmployeeId: string | null;
      approverRoleId: string | null;
    }
  | { kind: StepKind; status: 'SKIPPED'; reason: string };

/**
 * Turns a configured chain into the approvers for one request (spec §3.3, BR-11).
 *
 * - A step that cannot be resolved (no supervisor, no department head) is skipped.
 * - A step that would have the applicant approve their own leave is skipped.
 * - A person who already approves an earlier step is not asked twice.
 * - If nothing is left, the request goes to `fallbackRoleId` (HR) so it can never be stuck.
 */
export function resolveApprovalSteps(
  chain: readonly ChainStep[],
  applicant: Applicant,
  fallbackRoleId: string,
): ResolvedStep[] {
  const seen = new Set<string>();
  const out: ResolvedStep[] = [];
  const person = (kind: StepKind, id: string | null, missing: string): ResolvedStep => {
    if (!id) return { kind, status: 'SKIPPED', reason: missing };
    if (id === applicant.employeeId)
      return { kind, status: 'SKIPPED', reason: 'Applicants do not approve their own requests' };
    if (seen.has(`e:${id}`))
      return { kind, status: 'SKIPPED', reason: 'Same approver as an earlier step' };
    seen.add(`e:${id}`);
    return { kind, status: 'ACTIVE', approverEmployeeId: id, approverRoleId: null };
  };

  for (const step of chain) {
    switch (step.kind) {
      case 'SUPERVISOR':
        out.push(person(step.kind, applicant.supervisorId, 'No supervisor assigned'));
        break;
      case 'DEPARTMENT_HEAD':
        out.push(person(step.kind, applicant.departmentHeadId, 'No department head assigned'));
        break;
      case 'EMPLOYEE':
        out.push(person(step.kind, step.employeeId, 'No approver configured'));
        break;
      case 'ROLE':
        if (!step.roleId)
          out.push({ kind: step.kind, status: 'SKIPPED', reason: 'No role configured' });
        else if (seen.has(`r:${step.roleId}`))
          out.push({
            kind: step.kind,
            status: 'SKIPPED',
            reason: 'Same approver as an earlier step',
          });
        else {
          seen.add(`r:${step.roleId}`);
          out.push({
            kind: step.kind,
            status: 'ACTIVE',
            approverEmployeeId: null,
            approverRoleId: step.roleId,
          });
        }
        break;
    }
  }
  if (!out.some((s) => s.status === 'ACTIVE'))
    out.push({
      kind: 'ROLE',
      status: 'ACTIVE',
      approverEmployeeId: null,
      approverRoleId: fallbackRoleId,
    });
  return out;
}
