-- SGO on Supabase — configurable brand identity (accent color, display
-- name, logo) per company. Same pattern as login_max_attempts/
-- login_lockout_minutes (0008_auth_functions.sql): plain columns on
-- companies, added with `alter table ... add column`.

alter table companies add column accent_color text not null default '#1f6b45';
alter table companies add column display_name text;
alter table companies add column logo_url text;

-- There is no companies_update RLS policy at all today (only
-- companies_select) — nobody can write to this table from the client.
-- Following the same convention as every other mutation in this project
-- (set_profile_active, set_profile_role, ...): a dedicated
-- security-definer function instead of opening a raw update policy, so
-- the admin-only check lives in one place and can't be bypassed by a
-- direct PATCH even if a future policy were added carelessly.
create function update_company_branding(p_accent_color text, p_display_name text, p_logo_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_privileged() then
    raise exception 'SGO_FORBIDDEN: only admin/diretoria/auditoria may change company branding';
  end if;
  if coalesce(trim(p_accent_color), '') = '' then
    raise exception 'SGO_ACCENT_COLOR_REQUIRED: informe uma cor de destaque';
  end if;
  update companies
    set accent_color = p_accent_color,
        display_name = nullif(trim(coalesce(p_display_name, '')), ''),
        logo_url = nullif(trim(coalesce(p_logo_url, '')), '')
    where id = current_company();
end;
$$;

-- Read-only, callable by any authenticated user (every screen needs this
-- to paint the sidebar/topbar), returns just the branding-relevant
-- columns rather than the whole companies row.
create function current_company_branding()
returns table(name text, display_name text, accent_color text, logo_url text)
language sql
security definer
stable
set search_path = public
as $$
  select c.name, c.display_name, c.accent_color, c.logo_url
  from companies c
  where c.id = current_company();
$$;

grant execute on function update_company_branding(text, text, text) to authenticated;
grant execute on function current_company_branding() to authenticated;
