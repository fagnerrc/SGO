-- SGO on Supabase — Storage bucket for uploaded company logos (checklist
-- part 7/7, the last one). Public read (the sidebar/topbar logo needs to
-- render for every authenticated user regardless of role, and signed URLs
-- would be overkill for a non-sensitive brand asset); write restricted to
-- is_privileged() and scoped to the caller's own company via the object
-- path's first folder segment.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('branding-logos', 'branding-logos', true, 5242880, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

create policy branding_logos_public_read on storage.objects for select
  using (bucket_id = 'branding-logos');

create policy branding_logos_insert on storage.objects for insert
  with check (
    bucket_id = 'branding-logos'
    and is_privileged()
    and (storage.foldername(name))[1] = current_company()::text
  );

create policy branding_logos_update on storage.objects for update
  using (
    bucket_id = 'branding-logos'
    and is_privileged()
    and (storage.foldername(name))[1] = current_company()::text
  );

create policy branding_logos_delete on storage.objects for delete
  using (
    bucket_id = 'branding-logos'
    and is_privileged()
    and (storage.foldername(name))[1] = current_company()::text
  );
