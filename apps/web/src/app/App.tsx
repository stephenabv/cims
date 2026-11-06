import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { SecurityPage } from '@/features/account/SecurityPage';
import { ChangePasswordPage } from '@/features/auth/ChangePasswordPage';
import { ForgotPasswordPage } from '@/features/auth/ForgotPasswordPage';
import { LoginPage } from '@/features/auth/LoginPage';
import { ResetPasswordPage } from '@/features/auth/ResetPasswordPage';
import { AttendanceMonitorPage } from '@/features/attendance/AttendanceMonitorPage';
import {
  EmployeeAttendancePage,
  MyAttendancePage,
} from '@/features/attendance/AttendanceHistoryPage';
import { ConflictsPage } from '@/features/attendance/ConflictsPage';
import { LeaveApprovalsPage, LeaveRequestsPage, MyLeavePage } from '@/features/leave/LeavePages';
import { LeaveSettingsPage } from '@/features/leave/LeaveSettingsPage';
import { KioskDevicesPage } from '@/features/attendance/KioskDevicesPage';
import { SchedulesPage } from '@/features/attendance/SchedulesPage';
import { EmployeeDetailPage, MyProfilePage } from '@/features/employees/EmployeeDetailPage';
import { EmployeesPage } from '@/features/employees/EmployeesPage';
import { ProvisionEmployeePage } from '@/features/employees/ProvisionEmployeePage';
import { HomePage } from '@/features/home/HomePage';
import { KioskPage } from '@/features/kiosk/KioskPage';
import { OrgPage } from '@/features/org/OrgPage';
import { ApiError } from '@/lib/api-client';
import { AuthProvider } from '@/lib/auth';
import { AppShell } from './layout/AppShell';
import { NotFoundPage } from './NotFoundPage';
import { RequireAuth } from './RequireAuth';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Never retry client errors (401/403/404/validation); retry transient failures twice.
        retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
        refetchOnWindowFocus: false,
      },
    },
  });
}

export function AppRoutes() {
  return (
    <Routes>
      {/* The attendance kiosk is the default landing page (§3.1); staff sign in from there. */}
      <Route path="/" element={<KioskPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route
        path="/change-password"
        element={
          <RequireAuth allowPasswordChange>
            <ChangePasswordPage />
          </RequireAuth>
        }
      />
      <Route
        path="/app"
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<HomePage />} />
        <Route path="security" element={<SecurityPage />} />
        <Route path="profile" element={<MyProfilePage />} />
        <Route path="employees" element={<EmployeesPage />} />
        <Route path="employees/new" element={<ProvisionEmployeePage />} />
        <Route path="employees/:id" element={<EmployeeDetailPage />} />
        <Route path="org" element={<OrgPage />} />
        <Route path="attendance" element={<MyAttendancePage />} />
        <Route path="attendance/monitor" element={<AttendanceMonitorPage />} />
        <Route path="attendance/employees/:id" element={<EmployeeAttendancePage />} />
        <Route path="attendance/conflicts" element={<ConflictsPage />} />
        <Route path="schedules" element={<SchedulesPage />} />
        <Route path="kiosk-devices" element={<KioskDevicesPage />} />
        <Route path="leave" element={<MyLeavePage />} />
        <Route path="leave/approvals" element={<LeaveApprovalsPage />} />
        <Route path="leave/requests" element={<LeaveRequestsPage />} />
        <Route path="leave/settings" element={<LeaveSettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

export function App({ queryClient = createQueryClient() }: { queryClient?: QueryClient }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
