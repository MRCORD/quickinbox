-- Optional external identity providers (AUTH_MODE=clerk). Additive: existing
-- rows stay 'password' users and nothing changes unless an operator opts in.
--
-- `password_hash` stays NOT NULL. Users backed by an IdP store the sentinel '!',
-- which verifyPassword() can never match (it has no salt:hash shape), so the
-- password path stays closed for them without rebuilding a table that eleven
-- others reference.
ALTER TABLE users ADD COLUMN auth_provider TEXT NOT NULL DEFAULT 'password';
ALTER TABLE users ADD COLUMN external_id TEXT;

CREATE UNIQUE INDEX idx_users_external
	ON users(auth_provider, external_id)
	WHERE external_id IS NOT NULL;
