import { z } from "zod";

/** No control characters (log/UI safety); trimmed; bounded. */
export const projectName = z
  .string()
  .trim()
  .min(1, "name is required")
  .max(60, "name is too long")
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "invalid characters");

export const createProjectInput = z.object({ name: projectName }).strict();
export const renameProjectInput = z.object({ name: projectName }).strict();
export const projectId = z.string().uuid();

export type CreateProjectInput = z.infer<typeof createProjectInput>;
