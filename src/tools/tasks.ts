import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getSupabaseClient, formatSupabaseError } from "../services/supabase.js";
import { CHARACTER_LIMIT } from "../constants.js";
import type { Task } from "../types.js";

const StatusEnum = z.enum(["todo", "in_progress", "done"]);
const PriorityEnum = z.enum(["low", "medium", "high"]);

function truncateText(text: string, limit: number = CHARACTER_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[Output truncated at ${limit} characters. Use filters or pagination to narrow results.]`;
}

function formatTaskMarkdown(task: Task): string {
  const due = task.due_date ? task.due_date : "none";
  return `- **${task.title}** (${task.id})\n  status: ${task.status} | priority: ${task.priority} | due: ${due}\n  ${task.description ?? ""}`.trimEnd();
}

const ListTasksInputSchema = z
  .object({
    status: StatusEnum.optional().describe("Filter by task status"),
    priority: PriorityEnum.optional().describe("Filter by task priority"),
    limit: z.number().int().min(1).max(100).default(20).describe("Maximum results to return (default 20, max 100)"),
    offset: z.number().int().min(0).default(0).describe("Number of results to skip for pagination"),
  })
  .strict();
type ListTasksInput = z.infer<typeof ListTasksInputSchema>;

const GetTaskInputSchema = z
  .object({
    id: z.string().uuid().describe("The UUID of the task to fetch"),
  })
  .strict();
type GetTaskInput = z.infer<typeof GetTaskInputSchema>;

const CreateTaskInputSchema = z
  .object({
    title: z.string().min(1).max(200).describe("Short title of the task"),
    description: z.string().max(4000).optional().describe("Longer free-text description of the task"),
    status: StatusEnum.default("todo").describe("Initial status (default 'todo')"),
    priority: PriorityEnum.default("medium").describe("Priority level (default 'medium')"),
    due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD").optional().describe("Due date in YYYY-MM-DD format"),
  })
  .strict();
type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

const UpdateTaskInputSchema = z
  .object({
    id: z.string().uuid().describe("The UUID of the task to update"),
    title: z.string().min(1).max(200).optional().describe("New title"),
    description: z.string().max(4000).optional().describe("New description"),
    status: StatusEnum.optional().describe("New status"),
    priority: PriorityEnum.optional().describe("New priority"),
    due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD").optional().describe("New due date in YYYY-MM-DD format"),
  })
  .strict();
type UpdateTaskInput = z.infer<typeof UpdateTaskInputSchema>;

const DeleteTaskInputSchema = z
  .object({
    id: z.string().uuid().describe("The UUID of the task to delete"),
  })
  .strict();
type DeleteTaskInput = z.infer<typeof DeleteTaskInputSchema>;

export function registerTaskTools(server: McpServer): void {
  server.registerTool(
    "prestige_list_tasks",
    {
      title: "List Tasks",
      description: `List tasks from the Prestige Agentic database, optionally filtered by status or priority.

Args:
  - status ('todo' | 'in_progress' | 'done', optional): Filter by status
  - priority ('low' | 'medium' | 'high', optional): Filter by priority
  - limit (number): Max results to return, 1-100 (default: 20)
  - offset (number): Results to skip for pagination (default: 0)

Returns:
  JSON with { total, count, offset, tasks: Task[], has_more, next_offset }

Examples:
  - Use when: "Show me all open tasks" -> status="todo"
  - Use when: "What's high priority right now" -> priority="high", status="in_progress"
  - Don't use when: you already know the task's id (use prestige_get_task instead)

Error Handling:
  - Returns "No tasks found matching the given filters" if the query returns empty`,
      inputSchema: ListTasksInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: ListTasksInput) => {
      try {
        const supabase = getSupabaseClient();
        let query = supabase
          .from("tasks")
          .select("*", { count: "exact" })
          .order("created_at", { ascending: false })
          .range(params.offset, params.offset + params.limit - 1);

        if (params.status) query = query.eq("status", params.status);
        if (params.priority) query = query.eq("priority", params.priority);

        const { data, error, count } = await query;

        if (error) {
          return { content: [{ type: "text" as const, text: formatSupabaseError(error) }], isError: true };
        }

        const tasks = (data ?? []) as Task[];
        const total = count ?? tasks.length;

        if (!tasks.length) {
          return { content: [{ type: "text" as const, text: "No tasks found matching the given filters." }] };
        }

        const hasMore = total > params.offset + tasks.length;
        const output = {
          total,
          count: tasks.length,
          offset: params.offset,
          tasks,
          has_more: hasMore,
          ...(hasMore ? { next_offset: params.offset + tasks.length } : {}),
        };

        const markdown = [
          `Found ${total} task(s), showing ${tasks.length} starting at offset ${params.offset}:`,
          ...tasks.map(formatTaskMarkdown),
        ].join("\n");

        return {
          content: [{ type: "text" as const, text: truncateText(markdown) }],
          structuredContent: output,
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Unexpected error listing tasks: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "prestige_get_task",
    {
      title: "Get Task",
      description: `Fetch a single task by its UUID.

Args:
  - id (string, UUID): The task's unique identifier

Returns:
  JSON with the full Task object, or an error if not found.

Examples:
  - Use when: you have a task id from a prior list_tasks call and need full details
  - Don't use when: you don't have the id yet (use prestige_list_tasks first)

Error Handling:
  - Returns "Task <id> not found" if no matching row exists`,
      inputSchema: GetTaskInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: GetTaskInput) => {
      try {
        const supabase = getSupabaseClient();
        const { data, error } = await supabase.from("tasks").select("*").eq("id", params.id).maybeSingle();

        if (error) {
          return { content: [{ type: "text" as const, text: formatSupabaseError(error) }], isError: true };
        }
        if (!data) {
          return { content: [{ type: "text" as const, text: `Task ${params.id} not found.` }], isError: true };
        }

        const task = data as Task;
        return {
          content: [{ type: "text" as const, text: formatTaskMarkdown(task) }],
          structuredContent: task,
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Unexpected error fetching task: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "prestige_create_task",
    {
      title: "Create Task",
      description: `Create a new task in the Prestige Agentic database.

Args:
  - title (string, required): Short title, 1-200 chars
  - description (string, optional): Longer description, up to 4000 chars
  - status ('todo' | 'in_progress' | 'done', optional): Defaults to 'todo'
  - priority ('low' | 'medium' | 'high', optional): Defaults to 'medium'
  - due_date (string, optional): YYYY-MM-DD

Returns:
  JSON with the newly created Task object, including its generated id.

Examples:
  - Use when: "Add a task to follow up with the client next Friday"
  - Don't use when: the task already exists (use prestige_update_task instead)

Error Handling:
  - Returns "Supabase error: ..." with the underlying database error if the insert fails`,
      inputSchema: CreateTaskInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params: CreateTaskInput) => {
      try {
        const supabase = getSupabaseClient();
        const { data, error } = await supabase
          .from("tasks")
          .insert({
            title: params.title,
            description: params.description ?? null,
            status: params.status,
            priority: params.priority,
            due_date: params.due_date ?? null,
          })
          .select("*")
          .single();

        if (error) {
          return { content: [{ type: "text" as const, text: formatSupabaseError(error) }], isError: true };
        }

        const task = data as Task;
        return {
          content: [{ type: "text" as const, text: `Created task:\n${formatTaskMarkdown(task)}` }],
          structuredContent: task,
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Unexpected error creating task: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "prestige_update_task",
    {
      title: "Update Task",
      description: `Update one or more fields of an existing task. Only fields you provide are changed.

Args:
  - id (string, UUID, required): The task to update
  - title, description, status, priority, due_date (all optional): New values

Returns:
  JSON with the updated Task object.

Examples:
  - Use when: "Mark task X as done" -> id=X, status="done"
  - Use when: "Bump the priority on the client follow-up" -> id=<id>, priority="high"
  - Don't use when: the task doesn't exist yet (use prestige_create_task instead)

Error Handling:
  - Returns "Task <id> not found" if no matching row exists
  - Returns "No fields to update" if called with only an id`,
      inputSchema: UpdateTaskInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: UpdateTaskInput) => {
      const { id, ...fields } = params;
      const updates = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

      if (Object.keys(updates).length === 0) {
        return { content: [{ type: "text" as const, text: "No fields to update. Provide at least one field besides id." }], isError: true };
      }

      try {
        const supabase = getSupabaseClient();
        const { data, error } = await supabase
          .from("tasks")
          .update({ ...updates, updated_at: new Date().toISOString() })
          .eq("id", id)
          .select("*")
          .maybeSingle();

        if (error) {
          return { content: [{ type: "text" as const, text: formatSupabaseError(error) }], isError: true };
        }
        if (!data) {
          return { content: [{ type: "text" as const, text: `Task ${id} not found.` }], isError: true };
        }

        const task = data as Task;
        return {
          content: [{ type: "text" as const, text: `Updated task:\n${formatTaskMarkdown(task)}` }],
          structuredContent: task,
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Unexpected error updating task: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "prestige_delete_task",
    {
      title: "Delete Task",
      description: `Permanently delete a task by its UUID. This cannot be undone.

Args:
  - id (string, UUID, required): The task to delete

Returns:
  Confirmation message on success.

Examples:
  - Use when: "Remove the duplicate task" (after confirming the correct id via prestige_list_tasks)

Error Handling:
  - Returns "Task <id> not found" if no matching row exists`,
      inputSchema: DeleteTaskInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: DeleteTaskInput) => {
      try {
        const supabase = getSupabaseClient();
        const { data, error } = await supabase.from("tasks").delete().eq("id", params.id).select("id").maybeSingle();

        if (error) {
          return { content: [{ type: "text" as const, text: formatSupabaseError(error) }], isError: true };
        }
        if (!data) {
          return { content: [{ type: "text" as const, text: `Task ${params.id} not found.` }], isError: true };
        }

        return { content: [{ type: "text" as const, text: `Deleted task ${params.id}.` }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Unexpected error deleting task: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );
}
