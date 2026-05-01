# Team Lock Protocol- Phase 2 Audit Fixes

## Directories
- `.locks/tasks/`- one lock file per task (registers ownership)
- `.locks/files/`- one lock file per source file being edited (prevents concurrent edits)
- `.locks/reports/`- completion reports (one per completed task)

## Lock registration (agents MUST use these exact commands)

### Claim a task
```
touch .locks/tasks/<TASK_ID>.lock
echo "<worker_name>|$(date -u +%Y-%m-%dT%H:%M:%SZ)|CLAIMED" > .locks/tasks/<TASK_ID>.lock
```

### Claim a file before editing
```
# Sanitize path: replace / with __
# src/components/semiconductors/bjt.ts -> src__components__semiconductors__bjt.ts
touch .locks/files/<SANITIZED_FILE>.lock
echo "<worker_name>|<TASK_ID>|$(date -u +%Y-%m-%dT%H:%M:%SZ)" > .locks/files/<SANITIZED_FILE>.lock
```

### Release a file lock after editing
```
rm .locks/files/<SANITIZED_FILE>.lock
```

### Release a task lock after completion
```
rm .locks/tasks/<TASK_ID>.lock
```

### Check a lock (before claiming)
```
ls .locks/files/<SANITIZED_FILE>.lock 2>/dev/null  # non-empty means locked
ls .locks/tasks/<TASK_ID>.lock 2>/dev/null
```

## Completion report
Write `.locks/reports/<TASK_ID>.md` with 2-3 line description, then SendMessage team-lead.

## Rules
- NEVER edit a file whose lock exists and is owned by another worker.
- If a file lock is stale (worker dropped), SendMessage team-lead- do NOT clear it yourself.
- Task lock stays for entire task lifetime; file locks are per-edit-session.
- ALWAYS release file locks immediately after saving edits; keep task locks until task completed.
