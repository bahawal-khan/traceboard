// One-time (per Neon branch) role setup. Run as the Neon owner role.
//   ADMIN_DATABASE_URL=... APP_RW_PASSWORD=... MIGRATOR_PASSWORD=... npm run db:setup-roles
// Passwords come from env only and travel as bound parameters (set_config in a
// transaction), never in SQL text, the repo, or migrations. Nothing is printed.
import { neon } from "@neondatabase/serverless";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may come from the shell */
}

const { ADMIN_DATABASE_URL, APP_RW_PASSWORD, MIGRATOR_PASSWORD } = process.env;
const missing = ["ADMIN_DATABASE_URL", "APP_RW_PASSWORD", "MIGRATOR_PASSWORD"].filter((n) => !process.env[n]);
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(", ")}`);
  process.exit(1);
}
// Neon requires >= 60 bits of entropy; require 32+ chars of a generated password.
const weak = ["APP_RW_PASSWORD", "MIGRATOR_PASSWORD"].filter((n) => process.env[n].length < 32);
if (weak.length) {
  console.error(`Too short (need 32+ characters, e.g. \`openssl rand -hex 24\`): ${weak.join(", ")}`);
  process.exit(1);
}
if (APP_RW_PASSWORD === MIGRATOR_PASSWORD) {
  console.error("APP_RW_PASSWORD and MIGRATOR_PASSWORD must differ.");
  process.exit(1);
}

const sql = neon(ADMIN_DATABASE_URL);

// neondb_owner is not a real superuser, so we never ALTER role attributes
// (SUPERUSER, BYPASSRLS, ...). CREATE ROLE defaults are already the safe ones
// (NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS); ALTER ROLE
// only rotates the password. The verification block below proves the result.
const roleBlock = `
do $$
declare
  r record;
begin
  for r in select * from (values
      ('app_rw',    current_setting('setup.app_rw_pw')),
      ('migrator',  current_setting('setup.migrator_pw'))
    ) as t(name, pw)
  loop
    if not exists (select 1 from pg_roles where rolname = r.name) then
      execute format('create role %I login password %L', r.name, r.pw);
    else
      execute format('alter role %I password %L', r.name, r.pw);
    end if;
  end loop;

  execute format('grant connect on database %I to app_rw, migrator', current_database());
  execute format('grant create on database %I to migrator', current_database());
end
$$`;

// Fails the whole transaction (nothing is committed) if either role has a
// dangerous attribute, including a pre-existing role from an earlier run.
const verifyBlock = `
do $$
declare
  bad text;
begin
  select string_agg(rolname || ': ' || concat_ws(', ',
           case when rolsuper then 'rolsuper' end,
           case when rolcreatedb then 'rolcreatedb' end,
           case when rolcreaterole then 'rolcreaterole' end,
           case when rolbypassrls then 'rolbypassrls' end,
           case when rolreplication then 'rolreplication' end), '; ')
    into bad
    from pg_roles
   where rolname in ('app_rw', 'migrator')
     and (rolsuper or rolcreatedb or rolcreaterole or rolbypassrls or rolreplication);
  if bad is not null then
    raise exception 'Unsafe role attributes: %', bad;
  end if;
  if (select count(*) from pg_roles where rolname in ('app_rw', 'migrator')) <> 2 then
    raise exception 'Expected roles app_rw and migrator to exist';
  end if;
end
$$`;

await sql.transaction([
  sql`select set_config('setup.app_rw_pw', ${APP_RW_PASSWORD}, true), set_config('setup.migrator_pw', ${MIGRATOR_PASSWORD}, true)`,
  sql.query(roleBlock),
  // No default CREATE for everyone; migrator owns objects, app_rw only uses the schema.
  sql.query("revoke create on schema public from public"),
  sql.query("grant usage, create on schema public to migrator"),
  sql.query("grant usage on schema public to app_rw"),
  sql.query(verifyBlock),
]);

console.log("Roles app_rw and migrator are ready and verified safe (passwords set from env).");
