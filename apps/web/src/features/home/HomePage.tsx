import { Card, PageHeader } from '@/components/ui/Card';
import { useAuth } from '@/lib/auth';

export function HomePage() {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <>
      <PageHeader
        title={`Welcome, ${user.fullName}`}
        description="Your role-specific dashboard will appear here as modules are released."
      />
      <Card title="Your account">
        <dl className="grid gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-slate-500 dark:text-slate-400">Account number</dt>
            <dd className="font-mono font-medium">{user.accountNumber}</dd>
          </div>
          <div>
            <dt className="text-slate-500 dark:text-slate-400">Role</dt>
            <dd className="font-medium">{user.role.name}</dd>
          </div>
          <div>
            <dt className="text-slate-500 dark:text-slate-400">Company email</dt>
            <dd className="font-medium break-all">{user.email}</dd>
          </div>
        </dl>
      </Card>
    </>
  );
}
