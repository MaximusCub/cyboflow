-- Migration 125: admit the 'create-backlog-items' proposal kind on
-- agent_proposals.kind.
--
-- WHY. The global assistant had no path to put anything on the backlog: its
-- one write-shaped tool (cyboflow_propose_action) only accepted the four
-- kinds migration 074 froze into this CHECK, so "add a task for X" had no
-- proposal to record. The new kind records a batch of ideas/epics/tasks the
-- human confirms, which the executor then creates through TaskChangeRouter
-- stamped actor:'user'.
--
-- WHY a full recreate rather than 117's shadow-column recipe. `kind` is
-- TEXT NOT NULL with NO default, and ALTER TABLE ... ADD COLUMN cannot add a
-- NOT NULL column without one — the shadow recipe would force inventing a
-- DEFAULT this column never had. agent_proposals is safe to rebuild whole:
-- 074 is the ONLY migration that touches it (no ALTERed-in columns to lose,
-- the 103 hazard), nothing FKs INTO it, and it carries no index, trigger, or
-- view. Its own FK out to agent_threads is re-declared below.

-- The runner detects this marker and wraps every statement in an explicit
-- transaction with foreign keys disabled — required so the DROP TABLE below
-- is evaluated with FK enforcement off, exactly as 123 does.
PRAGMA foreign_keys=OFF;

CREATE TABLE agent_proposals_new (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN
    ('launch-run','reprioritize-backlog','edit-workflow','open-session','create-backlog-items')),
  payload_json TEXT NOT NULL,
  preconditions_json TEXT,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN
    ('proposed','executing','executed','failed','dismissed','superseded')),
  result_json TEXT,
  idempotency_key TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  decided_at DATETIME
);

INSERT INTO agent_proposals_new (id, thread_id, kind, payload_json, preconditions_json,
                                 status, result_json, idempotency_key, created_at, decided_at)
  SELECT id, thread_id, kind, payload_json, preconditions_json,
         status, result_json, idempotency_key, created_at, decided_at
  FROM agent_proposals;

DROP TABLE agent_proposals;
ALTER TABLE agent_proposals_new RENAME TO agent_proposals;

PRAGMA foreign_keys=ON;
