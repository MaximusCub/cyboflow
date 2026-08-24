-- Migration 120: Backfill sessions.idle_since for rows that were already at
-- rest when 119 added the column.
--
-- WHY THIS IS NOT OPTIONAL. 119's reader-side `COALESCE(idle_since,
-- updated_at)` makes a NULL row read exactly as it did pre-migration — but
-- only at the INSTANT of migration. After that the two diverge, and not in the
-- harmless direction:
--
--   * a write with NO status never reaches the idle_since CASE (it is gated on
--     `data.status !== undefined` in Database.updateSession) yet still bumps
--     updated_at, so COALESCE follows updated_at forward — a rename or a folder
--     move resets the quiet clock, which is the exact bug 119 exists to fix;
--   * a resting→resting status write (stopped→failed, and the exit-code paths
--     in ipc/session.ts and taskQueue.ts) takes the CASE's ELSE arm, preserving
--     NULL, and bumps updated_at too.
--
-- The row self-heals only on its next genuine busy→resting transition. For a
-- parked idle chat session — precisely the population the quick-session board
-- renders — that may never come, so the window is permanent rather than
-- transient. Backfilling closes it for every existing install.
--
-- `updated_at` is the right value to seed: for a row already at rest it IS the
-- last thing that session did, the same reasoning markSessionsAsStopped uses.
--
-- The `status NOT IN ('running','pending')` filter is load-bearing. Migrations
-- run inside DatabaseService.initialize(), BEFORE SessionManager's boot sweep
-- (markSessionsAsStopped) has reconciled rows left `running` by a crash. Those
-- rows must stay NULL here so the sweep's own COALESCE(idle_since, updated_at)
-- is what stamps them — and so NULL keeps meaning "not resting" throughout the
-- window.
--
-- `idle_since IS NULL` makes this idempotent: a ledger-wiped replay re-runs the
-- file and touches nothing that has since been stamped (the convergence
-- property 088's header describes).
--
-- Separate file from 119 rather than a second statement in it: the runner execs
-- a whole file inside one transaction, so on a replay 119's duplicate-column
-- ALTER rolls back everything after it in the same file — see 113's and 088's
-- headers for the full hazard.
--
-- NOTE: runFileBasedMigrations() in database.ts wraps every file in a
-- this.transaction(...) call, so no explicit BEGIN/COMMIT here.

UPDATE sessions
   SET idle_since = updated_at
 WHERE idle_since IS NULL
   AND status NOT IN ('running', 'pending');
