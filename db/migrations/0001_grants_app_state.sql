-- app_state is global (no tenant data). Explicit least-privilege grants: no DELETE.
GRANT SELECT, INSERT, UPDATE ON app_state TO app_rw;
