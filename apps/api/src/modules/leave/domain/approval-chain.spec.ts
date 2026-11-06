import { type Applicant, type ChainStep, resolveApprovalSteps } from './approval-chain';

const HR = 'role-hr';
const supervisorThenHr: ChainStep[] = [
  { kind: 'SUPERVISOR', roleId: null, employeeId: null },
  { kind: 'ROLE', roleId: HR, employeeId: null },
];
const applicant = (o: Partial<Applicant> = {}): Applicant => ({
  employeeId: 'ana',
  supervisorId: 'ben',
  departmentHeadId: 'cara',
  ...o,
});
const active = (steps: ReturnType<typeof resolveApprovalSteps>) =>
  steps.map((s) => (s.status === 'ACTIVE' ? (s.approverEmployeeId ?? s.approverRoleId) : 'skip'));

describe('resolveApprovalSteps', () => {
  it('resolves the supervisor, then the role', () => {
    expect(active(resolveApprovalSteps(supervisorThenHr, applicant(), HR))).toEqual(['ben', HR]);
  });

  it('skips a missing supervisor and keeps the remaining steps', () => {
    const steps = resolveApprovalSteps(supervisorThenHr, applicant({ supervisorId: null }), HR);
    expect(active(steps)).toEqual(['skip', HR]);
    expect(steps[0]).toMatchObject({ status: 'SKIPPED', reason: 'No supervisor assigned' });
  });

  it('never lets applicants approve themselves and never asks the same person twice', () => {
    const chain: ChainStep[] = [
      { kind: 'SUPERVISOR', roleId: null, employeeId: null },
      { kind: 'DEPARTMENT_HEAD', roleId: null, employeeId: null },
      { kind: 'EMPLOYEE', roleId: null, employeeId: 'ana' },
    ];
    expect(active(resolveApprovalSteps(chain, applicant({ departmentHeadId: 'ben' }), HR))).toEqual(
      ['ben', 'skip', 'skip'],
    );
  });

  it('falls back to HR when nothing resolves, so a request is never stuck', () => {
    const chain: ChainStep[] = [{ kind: 'DEPARTMENT_HEAD', roleId: null, employeeId: null }];
    const steps = resolveApprovalSteps(chain, applicant({ departmentHeadId: 'ana' }), HR);
    expect(active(steps)).toEqual(['skip', HR]);
  });
});
