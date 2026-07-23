-- Migration 082: optional per-panel CLI substrate override.
--
-- NULL is deliberate: panels without an override inherit the session substrate
-- and therefore retain the pre-082 routing path byte-for-byte.
ALTER TABLE tool_panels ADD COLUMN substrate TEXT
  CHECK (substrate IS NULL OR substrate IN ('sdk', 'interactive'));
