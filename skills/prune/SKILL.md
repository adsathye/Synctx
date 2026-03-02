# Skill: prune-sessions

Prune old synced sessions that exceed a retention period.

## When to Use

- User asks to prune, clean up old, or remove stale sessions
- User wants to free space by removing sessions older than a certain number of days
- User mentions retention period or age-based cleanup

## Steps

1. Run `synctx prune --days <N>` where N is the number of days (default: 90)
2. Optionally filter by CLI: `synctx prune --days <N> --cli copilot` or `--cli claude`
3. The command lists matching sessions, asks for double confirmation, then deletes them
4. Pruned sessions are tombstoned — they will NOT be re-synced from other machines
5. Any tags pointing to pruned sessions are automatically released
6. Report the result to the user

## Examples

- "Prune sessions older than 30 days" → `synctx prune --days 30`
- "Clean up old Copilot sessions" → `synctx prune --cli copilot`
- "Remove stale sessions" → `synctx prune`

## Important

- This is a destructive operation — sessions cannot be recovered after pruning
- The command requires double confirmation from the user before proceeding
- Default retention is 90 days if no `--days` value is specified
