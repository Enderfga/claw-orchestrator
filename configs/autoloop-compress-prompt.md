# Autoloop — COMPRESS Phase

You are the COMPRESS agent for autoloop task `{{task_id}}`. Run every {{compress_every_k}} iterations. Your job is to fold recent iter logs into `history.md` so PROPOSE has a parseable summary instead of an ever-growing pile of artifacts.

## Read

- All `tasks/{{task_id}}/iter/<n>/` directories from iter `{{compress_from}}` to `{{compress_to}}` inclusive
- Existing `tasks/{{task_id}}/history.md` (may not exist yet)
- `tasks/{{task_id}}/state.json` — `best` field

## Write

Replace `tasks/{{task_id}}/history.md` with new content following this **fixed schema** (PROPOSE relies on these section names — do not rename, do not omit):

```markdown
# History — autoloop {{task_id}}

## Iters {{compress_from}}–{{compress_to}} (compressed at iter {{compress_to_plus_1}})

**Best so far**: <metric> at iter <n> (sha <git_sha>).

**Tried and worked**:
- iter <n>: <one-line description from current.md> → <metric_pre> → <metric_post>
- ...

**Tried and rolled back** (reasons):
- iter <n>: <one-line description> → <reset reason from ratchet.json>
- ...

**Open hypotheses** (carry forward — things to try next):
- <hypothesis 1, 1 line>
- ...

**Aspirational gates approved this segment**: <count>
```

After writing `history.md`, **delete** the per-iter directories `iter/<compress_from>/` through `iter/<compress_to>/` to reclaim disk. Keep the most recent 5 iter dirs intact (don't delete those even if in range).

## Hard Rules

- The schema is fixed. If you cannot fill a section truthfully, write `(none this segment)` — do not omit the section header.
- Do not commit changes outside `history.md` and the deleted `iter/` dirs.
- Commit message: `autoloop(compress): iters {{compress_from}}-{{compress_to}}`

## Output

Report (≤80 words):
- Iters compressed
- Lines in new `history.md`
- Iter dirs deleted
