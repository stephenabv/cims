import { provisionEmployeeSchema } from '@cims/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router-dom';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, PageHeader } from '@/components/ui/Card';
import { SelectField } from '@/components/ui/SelectField';
import { TextField } from '@/components/ui/TextField';
import { ApiError, errorMessage } from '@/lib/api-client';
import {
  useAssignableRoles,
  useDepartments,
  useEmployees,
  usePositions,
  useProvisionEmployee,
} from './api';
import { CLASSIFICATION_LABELS, toOptions } from './labels';

const nullIfEmpty = (v: unknown) => (v === '' ? null : v);

export function ProvisionEmployeePage() {
  const navigate = useNavigate();
  const departments = useDepartments();
  const positions = usePositions();
  const roles = useAssignableRoles();
  // Supervisor picker: first 100 employees by name. Larger organisations should switch to a search combobox.
  const supervisors = useEmployees({ page: 1, pageSize: 100, accountStatus: 'ACTIVE' });
  const provision = useProvisionEmployee();

  const form = useForm({
    resolver: zodResolver(provisionEmployeeSchema),
    defaultValues: {
      firstName: '',
      middleName: '',
      lastName: '',
      suffix: '',
      companyEmail: '',
      departmentId: null,
      positionId: null,
      supervisorId: null,
      classification: 'PROBATIONARY',
      dateHired: new Date().toISOString().slice(0, 10),
      roleId: '',
      contactNumber: '',
      residentialAddress: '',
      emergencyContactName: '',
      emergencyContactRelationship: '',
      emergencyContactPhone: '',
      activate: true,
    },
  });
  const errors = form.formState.errors;
  const departmentId = form.watch('departmentId');

  const onSubmit = form.handleSubmit((values) =>
    provision.mutate(values, {
      onSuccess: ({ employee, credentialsDelivered }) =>
        navigate(`/app/employees/${employee.id}`, {
          state: { provisioned: true, credentialsDelivered },
        }),
      onError: (err) => {
        if (err instanceof ApiError)
          for (const [path, message] of Object.entries(err.fieldErrors()))
            form.setError(path as never, { message });
      },
    }),
  );

  return (
    <>
      <PageHeader
        title="Add employee"
        description="Creates the employee record and system account. Credentials are emailed to the company address."
      />
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-6">
        {provision.isError &&
          !(
            provision.error instanceof ApiError && provision.error.code === 'VALIDATION_FAILED'
          ) && <Alert tone="error">{errorMessage(provision.error)}</Alert>}

        <Card title="Identity">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="First name"
              autoComplete="off"
              error={errors.firstName?.message}
              {...form.register('firstName')}
            />
            <TextField
              label="Middle name (optional)"
              autoComplete="off"
              error={errors.middleName?.message}
              {...form.register('middleName')}
            />
            <TextField
              label="Last name"
              autoComplete="off"
              error={errors.lastName?.message}
              {...form.register('lastName')}
            />
            <TextField
              label="Suffix (optional)"
              placeholder="Jr., III"
              autoComplete="off"
              error={errors.suffix?.message}
              {...form.register('suffix')}
            />
            <TextField
              label="Company email"
              type="email"
              autoComplete="off"
              className="sm:col-span-2"
              error={errors.companyEmail?.message}
              {...form.register('companyEmail')}
            />
          </div>
        </Card>

        <Card title="Employment & access">
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label="Role"
              placeholder="Select a role"
              options={(roles.data ?? []).map((r) => ({ value: r.id, label: r.name }))}
              error={errors.roleId?.message ? 'Select a role' : undefined}
              {...form.register('roleId')}
            />
            <SelectField
              label="Classification"
              options={toOptions(CLASSIFICATION_LABELS)}
              error={errors.classification?.message}
              {...form.register('classification')}
            />
            <SelectField
              label="Department"
              placeholder="No department"
              options={(departments.data ?? [])
                .filter((d) => d.isActive)
                .map((d) => ({ value: d.id, label: d.name }))}
              error={errors.departmentId?.message}
              {...form.register('departmentId', { setValueAs: nullIfEmpty })}
            />
            <SelectField
              label="Position"
              placeholder="No position"
              options={(positions.data ?? [])
                .filter(
                  (p) =>
                    p.isActive &&
                    (!departmentId || !p.department || p.department.id === departmentId),
                )
                .map((p) => ({ value: p.id, label: p.title }))}
              error={errors.positionId?.message}
              {...form.register('positionId', { setValueAs: nullIfEmpty })}
            />
            <SelectField
              label="Supervisor / approver"
              placeholder="None"
              options={(supervisors.data?.data ?? []).map((e) => ({
                value: e.id,
                label: `${e.fullName} (${e.accountNumber})`,
              }))}
              error={errors.supervisorId?.message}
              {...form.register('supervisorId', { setValueAs: nullIfEmpty })}
            />
            <TextField
              label="Date hired"
              type="date"
              error={errors.dateHired?.message}
              {...form.register('dateHired')}
            />
          </div>
          <label className="mt-4 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 rounded border-slate-300"
              {...form.register('activate')}
            />
            Activate the account now (otherwise it stays pending until activated)
          </label>
        </Card>

        <Card
          title="Contact (optional)"
          description="The employee can fill these in later from their profile."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Contact number"
              type="tel"
              error={errors.contactNumber?.message}
              {...form.register('contactNumber')}
            />
            <TextField
              label="Residential address"
              error={errors.residentialAddress?.message}
              {...form.register('residentialAddress')}
            />
            <TextField
              label="Emergency contact name"
              error={errors.emergencyContactName?.message}
              {...form.register('emergencyContactName')}
            />
            <TextField
              label="Relationship"
              error={errors.emergencyContactRelationship?.message}
              {...form.register('emergencyContactRelationship')}
            />
            <TextField
              label="Emergency contact phone"
              type="tel"
              error={errors.emergencyContactPhone?.message}
              {...form.register('emergencyContactPhone')}
            />
          </div>
        </Card>

        <div className="flex flex-wrap gap-3">
          <Button type="submit" loading={provision.isPending}>
            Create employee
          </Button>
          <Link
            to="/app/employees"
            className="inline-flex min-h-10 items-center rounded-lg px-4 text-sm font-semibold text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            Cancel
          </Link>
        </div>
      </form>
    </>
  );
}
