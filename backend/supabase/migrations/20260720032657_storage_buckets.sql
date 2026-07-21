insert into storage.buckets (id, name, public) values ('playmymood', 'playmymood', false);

-- single bucket, folder-scoped by user: <user_id>/logs/..., <user_id>/covers/...
create policy "playmymood owner rw" on storage.objects
  for all
  using (bucket_id = 'playmymood' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'playmymood' and (storage.foldername(name))[1] = auth.uid()::text);
