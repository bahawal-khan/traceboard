-- P2.4c: event_content is keyed by (project_id, event_id), not event_id alone. With a global key, a
-- tenant that reuses another tenant's event id would block that tenant's content insert (a cross-tenant
-- interference), and ON CONFLICT would hide it. The original key was created inline in 0004, so its
-- name is the Postgres default `event_content_pkey`.
ALTER TABLE "event_content" DROP CONSTRAINT "event_content_pkey";--> statement-breakpoint
ALTER TABLE "event_content" ADD CONSTRAINT "event_content_project_id_event_id_pk" PRIMARY KEY("project_id","event_id");
