/**
 * Types shared between server actions and the client components that call them.
 * Kept out of the 'use server' modules, which may only export async functions.
 */
export interface ImportPreview {
  batchId: string | null;
  totalRows: number;
  valid: number;
  invalid: number;
  duplicatesInFile: number;
  alreadyPresent: number;
  suppressed: number;
  errors: Array<{ row: number; value: string; reason: string }>;
  sample: Array<Record<string, string>>;
  columns: string[];
}
