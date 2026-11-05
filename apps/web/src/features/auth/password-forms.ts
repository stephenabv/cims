import { PASSWORD_MAX_LENGTH, passwordSchema } from '@cims/shared';
import { z } from 'zod';

export const changePasswordFormSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password').max(PASSWORD_MAX_LENGTH),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    message: 'Choose a password you have not used here',
    path: ['newPassword'],
  });
export type ChangePasswordForm = z.infer<typeof changePasswordFormSchema>;

export const resetPasswordFormSchema = z
  .object({ newPassword: passwordSchema, confirmPassword: z.string() })
  .refine((v) => v.newPassword === v.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });
export type ResetPasswordForm = z.infer<typeof resetPasswordFormSchema>;

export const PASSWORD_HINT =
  'At least 12 characters, with upper- and lower-case letters and a number.';
