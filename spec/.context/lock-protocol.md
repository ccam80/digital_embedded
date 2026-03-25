# Lock Protocol

## Mechanism

`mkdir` is atomic on all platforms. Directory existence = lock held.

> **Windows note**: All bash commands in this file assume Git Bash. Always double-quote paths and use forward slashes. See the Shell Compatibility section in `rules.md`.

## Directory Structure

```
spec/.locks/
├── tasks/{task-id}/owner      # Task-level lock
└── files/{sanitized-path}/owner  # File-level lock
```

## Owner File Content

```
agent: {task_agent_id}
task: {task_id}
timestamp: {ISO 8601}
```

## Operations

### Acquire Task Lock

```bash
mkdir -p "spec/.locks/tasks" && mkdir "spec/.locks/tasks/${TASK_ID}" 2>/dev/null
if [ $? -eq 0 ]; then echo "ACQUIRED"; else echo "BUSY"; fi
```

### Write Owner Info

```bash
printf "agent: %s\ntask: %s\ntimestamp: %s\n" "$AGENT_ID" "$TASK_ID" "$(date -Iseconds)" > "spec/.locks/tasks/${TASK_ID}/owner"
```

### Release Task Lock

```bash
rm -rf "spec/.locks/tasks/${TASK_ID}"
```

### Acquire File Lock

Sanitize the file path: replace `/` and `\` with `__`, replace `:` with `_`.

```bash
LOCK_NAME=$(echo "$FILE_PATH" | sed 's/[\/\\]/__/g; s/:/_/g')
mkdir -p "spec/.locks/files" && mkdir "spec/.locks/files/${LOCK_NAME}" 2>/dev/null
if [ $? -eq 0 ]; then echo "ACQUIRED"; else echo "BUSY"; fi
```

### Write File Lock Owner

```bash
printf "agent: %s\ntask: %s\ntimestamp: %s\n" "$AGENT_ID" "$TASK_ID" "$(date -Iseconds)" > "spec/.locks/files/${LOCK_NAME}/owner"
```

### Release File Lock

```bash
rm -rf "spec/.locks/files/${LOCK_NAME}"
```

## Stale Lock Policy

The orchestrator cleans locks after implementer Tasks return. No timeout-based expiry — this avoids race conditions. If an implementer Task returns but its locks remain in `.locks/`, the orchestrator releases them (the agent crashed or forgot).

## Conflict Handling

If an implementer cannot acquire a file lock after a brief retry:
1. Skip the task
2. Note the conflict in the completion report
3. Release any locks already acquired for that task
4. Move on to the next available task
