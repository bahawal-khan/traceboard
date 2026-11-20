import { neonConfig } from "@neondatabase/serverless";

/**
 * Local / CI database support. The Neon serverless driver speaks HTTP, which plain Postgres does not,
 * so local runs and CI put the community `local-neon-http-proxy` in front of a Postgres container
 * (ci/docker-compose.db.yml). It is reached through the special host name below. For any other host
 * (real Neon) this does nothing, so production behaviour is unchanged.
 */
export const LOCAL_NEON_HOST = "db.localtest.me";
export const LOCAL_NEON_HTTP_PORT = 4444;

/** Points the driver at the local proxy when the connection string uses the local host. Returns true if it did. */
export function configureLocalNeon(connectionString) {
  let hostname;
  try {
    hostname = new URL(connectionString ?? "").hostname;
  } catch {
    return false;
  }
  if (hostname !== LOCAL_NEON_HOST) return false;
  neonConfig.fetchEndpoint = (host) => (host === LOCAL_NEON_HOST ? `http://${host}:${LOCAL_NEON_HTTP_PORT}/sql` : `https://${host}/sql`);
  return true;
}
