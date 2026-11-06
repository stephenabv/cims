import { z } from 'zod';

export const MAX_PAGE_SIZE = 100;

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
});
export type PaginationInput = z.infer<typeof paginationSchema>;

export const uuidSchema = z.string().uuid();

/** ISO calendar date (YYYY-MM-DD), interpreted in the company timezone. */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Invalid date');

export interface NotificationView {
  id: string;
  kind: string;
  title: string;
  body: string;
  /** In-app path to open. */
  link: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationList {
  unread: number;
  data: NotificationView[];
}
