import { z } from 'zod';
import { isoDateSchema, paginationSchema, uuidSchema } from './common';

export const EMPLOYMENT_CLASSIFICATIONS = [
  'REGULAR',
  'PROBATIONARY',
  'CONTRACTUAL',
  'PROJECT_BASED',
  'PART_TIME',
  'INTERN',
] as const;
export type EmploymentClassification = (typeof EMPLOYMENT_CLASSIFICATIONS)[number];

export const EMPLOYMENT_STATUSES = [
  'ACTIVE',
  'ON_LEAVE',
  'RESIGNED',
  'TERMINATED',
  'RETIRED',
] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

export const ACCOUNT_STATUSES = [
  'PENDING_ACTIVATION',
  'ACTIVE',
  'SUSPENDED',
  'DEACTIVATED',
] as const;

const name = (max: number) => z.string().trim().min(1, 'Required').max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();
const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ()-]{7,20}$/, 'Enter a valid phone number')
  .or(z.literal(''))
  .transform((v) => (v === '' ? null : v))
  .nullable()
  .optional();

export const companyEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Enter a valid email address')
  .max(254);

/** Fields an employee may edit on their own profile (§3.5 "designated personal information"). */
export const personalDetailsSchema = z.object({
  contactNumber: phone,
  residentialAddress: optionalText(500),
  emergencyContactName: optionalText(200),
  emergencyContactRelationship: optionalText(50),
  emergencyContactPhone: phone,
});
export type PersonalDetailsInput = z.infer<typeof personalDetailsSchema>;

export const updatePersonalDetailsSchema = personalDetailsSchema.extend({
  version: z.number().int().min(1),
});
export type UpdatePersonalDetailsInput = z.infer<typeof updatePersonalDetailsSchema>;

/** Restricted employment fields (authorised personnel only). */
export const employmentDetailsSchema = z.object({
  firstName: name(100),
  middleName: optionalText(100),
  lastName: name(100),
  suffix: optionalText(20),
  companyEmail: companyEmailSchema,
  departmentId: uuidSchema.nullable(),
  positionId: uuidSchema.nullable(),
  supervisorId: uuidSchema.nullable(),
  classification: z.enum(EMPLOYMENT_CLASSIFICATIONS),
  employmentStatus: z.enum(EMPLOYMENT_STATUSES),
  dateHired: isoDateSchema,
});

export const updateEmploymentSchema = employmentDetailsSchema
  .partial()
  .extend({ version: z.number().int().min(1), reason: z.string().trim().max(500).optional() });
export type UpdateEmploymentInput = z.infer<typeof updateEmploymentSchema>;

export const provisionEmployeeSchema = employmentDetailsSchema
  .omit({ employmentStatus: true })
  .merge(personalDetailsSchema)
  .extend({
    roleId: uuidSchema,
    /** Step 8 of §3.10. When false the account stays PENDING_ACTIVATION until activated. */
    activate: z.boolean().default(true),
  });
export type ProvisionEmployeeInput = z.infer<typeof provisionEmployeeSchema>;

export const changeRoleSchema = z.object({
  roleId: uuidSchema,
  reason: z.string().trim().min(3).max(500),
});
export type ChangeRoleInput = z.infer<typeof changeRoleSchema>;

export const LIFECYCLE_ACTIONS = ['activate', 'suspend', 'deactivate', 'reactivate'] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];
export const lifecycleSchema = z.object({
  reason: z.string().trim().min(3, 'Give a reason').max(500),
});
export type LifecycleInput = z.infer<typeof lifecycleSchema>;

export const employeeListQuerySchema = paginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  departmentId: uuidSchema.optional(),
  accountStatus: z.enum(ACCOUNT_STATUSES).optional(),
  sort: z.enum(['name', 'accountNumber', 'dateHired']).default('name'),
});
export type EmployeeListQuery = z.infer<typeof employeeListQuerySchema>;

export const departmentSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_-]{2,20}$/, '2–20 letters, digits, - or _'),
  name: name(100),
  headId: uuidSchema.nullable().optional(),
  isActive: z.boolean().default(true),
});
export type DepartmentInput = z.infer<typeof departmentSchema>;

export const positionSchema = z.object({
  title: name(100),
  departmentId: uuidSchema.nullable().optional(),
  isActive: z.boolean().default(true),
});
export type PositionInput = z.infer<typeof positionSchema>;

// ───────────── Response shapes ─────────────

export interface EmployeeSummary {
  id: string;
  accountNumber: string;
  fullName: string;
  companyEmail: string;
  department: { id: string; name: string } | null;
  position: { id: string; title: string } | null;
  role: { id: string; key: string; name: string } | null;
  accountStatus: (typeof ACCOUNT_STATUSES)[number] | null;
  employmentStatus: EmploymentStatus;
}

export interface EmployeeDetail extends EmployeeSummary {
  userId: string | null;
  firstName: string;
  middleName: string | null;
  lastName: string;
  suffix: string | null;
  contactNumber: string | null;
  residentialAddress: string | null;
  emergencyContactName: string | null;
  emergencyContactRelationship: string | null;
  emergencyContactPhone: string | null;
  supervisor: { id: string; fullName: string; accountNumber: string } | null;
  classification: EmploymentClassification;
  dateHired: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** What the viewer may do with this record (computed server-side; UX hint only). */
  capabilities: {
    editPersonal: boolean;
    editEmployment: boolean;
    manageLifecycle: boolean;
    resetCredentials: boolean;
    changeRole: boolean;
  };
}

export interface EmployeeChange {
  id: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
  changedBy: { id: string; fullName: string } | null;
  createdAt: string;
}
