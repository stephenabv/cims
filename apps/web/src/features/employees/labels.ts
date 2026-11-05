import type { EmployeeSummary, EmploymentClassification, EmploymentStatus } from '@cims/shared';

export const CLASSIFICATION_LABELS: Record<EmploymentClassification, string> = {
  REGULAR: 'Regular',
  PROBATIONARY: 'Probationary',
  CONTRACTUAL: 'Contractual',
  PROJECT_BASED: 'Project-based',
  PART_TIME: 'Part-time',
  INTERN: 'Intern',
};

export const EMPLOYMENT_STATUS_LABELS: Record<EmploymentStatus, string> = {
  ACTIVE: 'Active',
  ON_LEAVE: 'On leave',
  RESIGNED: 'Resigned',
  TERMINATED: 'Terminated',
  RETIRED: 'Retired',
};

type AccountStatus = NonNullable<EmployeeSummary['accountStatus']>;
export const ACCOUNT_STATUS: Record<
  AccountStatus,
  { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }
> = {
  ACTIVE: { label: 'Active', tone: 'success' },
  PENDING_ACTIVATION: { label: 'Pending activation', tone: 'warning' },
  SUSPENDED: { label: 'Suspended', tone: 'danger' },
  DEACTIVATED: { label: 'Deactivated', tone: 'neutral' },
};

export const toOptions = <K extends string>(labels: Record<K, string>) =>
  (Object.entries(labels) as [K, string][]).map(([value, label]) => ({ value, label }));

export const FIELD_LABELS: Record<string, string> = {
  record: 'Record',
  firstName: 'First name',
  middleName: 'Middle name',
  lastName: 'Last name',
  suffix: 'Suffix',
  companyEmail: 'Company email',
  contactNumber: 'Contact number',
  residentialAddress: 'Address',
  emergencyContactName: 'Emergency contact',
  emergencyContactRelationship: 'Emergency contact relationship',
  emergencyContactPhone: 'Emergency contact phone',
  departmentId: 'Department',
  positionId: 'Position',
  supervisorId: 'Supervisor',
  classification: 'Classification',
  employmentStatus: 'Employment status',
  dateHired: 'Date hired',
  accountStatus: 'Account status',
  role: 'Role',
};
