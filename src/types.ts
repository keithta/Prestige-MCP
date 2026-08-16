export type TaskStatus = "todo" | "in_progress" | "done";
export type TaskPriority = "low" | "medium" | "high";

export interface Task {
  [key: string]: unknown;
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due_date: string | null;
  created_at: string;
  updated_at: string;
}
