-- DEFTERAM : table des avis (notes envoyées depuis « Laisser une note »)
-- À exécuter une fois dans Supabase : SQL Editor → New query → coller → Run.

create table if not exists public.avis (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  note        smallint not null check (note between 1 and 5),
  commentaire text check (char_length(commentaire) <= 2000),
  langue      text check (char_length(langue) <= 5),
  nom         text check (char_length(nom) <= 30)
);

alter table public.avis enable row level security;

-- Les visiteurs (clé publique « anon ») peuvent seulement AJOUTER un avis.
-- Personne ne peut lire, modifier ou supprimer les avis depuis le site :
-- vous les consultez dans le tableau de bord Supabase (Table Editor → avis).
drop policy if exists "envoyer un avis" on public.avis;
create policy "envoyer un avis" on public.avis
  for insert to anon with check (true);

grant insert on public.avis to anon;
