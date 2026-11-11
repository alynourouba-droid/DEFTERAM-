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

-- ---------------------------------------------------------------------------
-- Comptes : sauvegarde des favoris, textes ajoutés et préférences
-- Chaque utilisateur ne peut lire et écrire QUE sa propre ligne.
-- ---------------------------------------------------------------------------
create table if not exists public.profils (
  id          uuid primary key references auth.users (id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  constraint profils_taille check (pg_column_size(data) < 1000000)
);

alter table public.profils enable row level security;

drop policy if exists "lire son profil" on public.profils;
create policy "lire son profil" on public.profils
  for select to authenticated using (id = auth.uid());

drop policy if exists "creer son profil" on public.profils;
create policy "creer son profil" on public.profils
  for insert to authenticated with check (id = auth.uid());

drop policy if exists "modifier son profil" on public.profils;
create policy "modifier son profil" on public.profils
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

grant select, insert, update on public.profils to authenticated;

-- IMPORTANT (connexion sans e-mail de confirmation) :
-- Authentication → Sign In / Providers → Email → désactiver « Confirm email ».
