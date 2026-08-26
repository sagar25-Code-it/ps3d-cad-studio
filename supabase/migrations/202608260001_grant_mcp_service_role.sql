-- Restore only the table privileges required by the trusted server-side MCP token service.
-- Browser roles remain revoked and raw personal tokens remain unavailable to PostgreSQL clients.

grant usage on schema public to service_role;
grant select, insert, update on table public.mcp_tokens to service_role;
