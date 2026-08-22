-- PS3D public account and remote MCP support.
-- Apply this migration in the Supabase SQL editor before enabling public token issuance.
-- Raw personal access tokens and user passwords are never stored in this schema.

create extension if not exists pgcrypto;

create table if not exists public.mcp_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 60),
  token_hash char(64) not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  token_prefix text not null check (char_length(token_prefix) between 16 and 32),
  scopes text[] not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  constraint mcp_tokens_future_expiry check (expires_at > created_at),
  constraint mcp_tokens_scope_set check (
    cardinality(scopes) between 1 and 3
    and scopes @> array['mcp:read']::text[]
    and scopes <@ array['mcp:read', 'mcp:preview', 'mcp:apply']::text[]
  )
);

create index if not exists mcp_tokens_user_created_idx on public.mcp_tokens (user_id, created_at desc);
create index if not exists mcp_tokens_active_hash_idx on public.mcp_tokens (token_hash) where revoked_at is null;

alter table public.mcp_tokens enable row level security;
alter table public.mcp_tokens force row level security;
revoke all on table public.mcp_tokens from anon, authenticated, public;

create or replace function public.enforce_active_mcp_token_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));
  if (
    select count(*)
    from public.mcp_tokens
    where user_id = new.user_id
      and revoked_at is null
      and expires_at > now()
  ) >= 5 then
    raise exception 'active MCP token limit reached' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_active_mcp_token_limit on public.mcp_tokens;
create trigger enforce_active_mcp_token_limit
before insert on public.mcp_tokens
for each row execute function public.enforce_active_mcp_token_limit();

revoke all on function public.enforce_active_mcp_token_limit() from public, anon, authenticated;

create table if not exists public.mcp_rate_windows (
  actor_hash char(64) not null check (actor_hash ~ '^[a-f0-9]{64}$'),
  window_start timestamptz not null,
  request_count integer not null check (request_count >= 0),
  primary key (actor_hash, window_start)
);

alter table public.mcp_rate_windows enable row level security;
alter table public.mcp_rate_windows force row level security;
revoke all on table public.mcp_rate_windows from anon, authenticated, public;

create or replace function public.consume_mcp_quota(p_actor_hash text, p_limit integer default 60)
returns table (allowed boolean, remaining integer, reset_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_window timestamptz := date_trunc('minute', now());
  current_count integer;
begin
  if p_actor_hash !~ '^[a-f0-9]{64}$' or p_limit < 1 or p_limit > 600 then
    raise exception 'invalid quota input' using errcode = '22023';
  end if;

  insert into public.mcp_rate_windows(actor_hash, window_start, request_count)
  values (p_actor_hash, current_window, 1)
  on conflict (actor_hash, window_start)
  do update set request_count = public.mcp_rate_windows.request_count + 1
  returning request_count into current_count;

  if random() < 0.01 then
    delete from public.mcp_rate_windows where window_start < now() - interval '2 hours';
  end if;

  return query select current_count <= p_limit, greatest(p_limit - current_count, 0), current_window + interval '1 minute';
end;
$$;

revoke all on function public.consume_mcp_quota(text, integer) from public, anon, authenticated;
grant execute on function public.consume_mcp_quota(text, integer) to service_role;

comment on table public.mcp_tokens is 'Peppered HMAC digests and metadata for revocable PS3D personal MCP tokens; raw tokens are never persisted.';
comment on table public.mcp_rate_windows is 'Short-lived aggregate request counters; no MCP payload, password, raw token, or project data is stored.';
