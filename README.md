# DEFTERAM

Bibliothèque islamique en arabe, français, anglais, pulaar et wolof : Coran (Mushaf de 604 pages), douaou, hadiths, poèmes, Wird Tijani, guides du woudou, du ghusl et de la prière.

Site statique sans étape de build, installable comme application (PWA) et utilisable hors connexion.

## Structure

| Fichier / dossier | Rôle |
|---|---|
| `index.html` | L'application complète (HTML, CSS, JS et textes) |
| `sw.js` | Service worker : hors connexion + mises à jour automatiques |
| `m/p/001.webp … 604.webp` | Pages du Mushaf (une image par page, ~45 Ko) |
| `b/` | Images des livres (manuscrits, Mukhtasar al-Akhdari) |
| `icons/`, `og.jpg`, `manifest.webmanifest` | Icônes, image de partage, manifeste de l'app |
| `privacy.html`, `404.html`, `robots.txt`, `sitemap.xml` | Pages et fichiers SEO |
| `api/auth.js` | Comptes utilisateurs (connexion sans e-mail) |
| `api/stats.js` | Compteurs anonymes (visiteurs, visites, partages) |
| `vercel.json` | En-têtes de cache et de sécurité pour Vercel |
| `supabase/schema.sql` | Tables Supabase (avis + comptes) |
| `tests/e2e.js` | Tests de bout en bout |

## Liens directs

Chaque écran a sa propre adresse, utilisable pour partager et pour le bouton Retour du téléphone :
`#/c/parab` (catégorie), `#/t/p2` (texte), `#/m/50` (page du Mushaf), `#/zikr`, `#/s/fatiha` (recherche), `#/p/compte`, `#/p/parametres`, `#/p/apropos`…

## Mise en service

### 1. Vercel
1. https://vercel.com/new → importer le dépôt GitHub `DEFTERAM-`.
2. Framework : **Other**, rien d'autre à changer → **Deploy**.
3. Chaque envoi sur `main` est publié automatiquement.

Le site utilise l'adresse `https://defteram.vercel.app` (balises de partage, canonical, sitemap). Si Vercel en donne une autre, remplacer cette adresse dans `index.html`, `robots.txt` et `sitemap.xml`.

### Base Upstash : compteurs + comptes utilisateurs
`api/auth.js` (comptes : identifiant ou e-mail + mot de passe haché scrypt, sans e-mail de confirmation, sessions de 90 jours, synchronisation des favoris) et `api/stats.js` utilisent la même base.

### Compteurs de visiteurs et de partages
La fonction `api/stats.js` compte les visiteurs (appareils), les visites et les partages, et l'app les affiche sur l'accueil et dans « À propos ».
1. Vercel → projet `defteram` → **Storage** → **Create Database** → **Upstash for Redis** (offre gratuite) → **Connect** au projet.
2. Redéployer (Deployments → ⋯ → Redeploy). Les variables `KV_REST_API_URL` / `KV_REST_API_TOKEN` (ou `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`) sont ajoutées automatiquement.

Tant que la base n'est pas reliée, aucun chiffre n'est affiché.

### Statistiques de fréquentation (Vercel Web Analytics)
Activé dans Vercel → projet `defteram` → **Analytics** (offre Hobby, gratuite). Le site charge `/_vercel/insights/script.js` (voir `index.html`) : rien à installer. Les chiffres (visiteurs, pages vues, pays, appareils, sources) sont visibles dans l'onglet Analytics de Vercel.

### 2. Supabase (comptes + avis)
1. Créer un projet sur https://supabase.com.
2. **SQL Editor** → coller `supabase/schema.sql` → **Run**.
3. **Authentication → Sign In / Providers → Email** : désactiver **Confirm email** (aucun e-mail de confirmation).
4. **Project Settings → API** : copier l'URL du projet et la clé **anon public**, puis les mettre dans `index.html` :
   ```js
   var SB={url:'https://xxxx.supabase.co',key:'eyJ...'};
   ```
   La clé *anon* est faite pour être publique. Ne jamais mettre la clé *service_role* dans le site.

Tant que `SB` est vide, la page Connexion l'indique clairement et « Laisser une note » passe par WhatsApp.

Connexion : un identifiant (3 à 30 caractères, sans espace) ou une adresse e-mail, et un mot de passe d'au moins 6 caractères. Les favoris, textes ajoutés, la page du Mushaf et les préférences sont synchronisés entre les appareils.

## Tests

```bash
node tests/e2e.js
```

Ils utilisent Playwright et Chromium. Le site est servi localement et Supabase est simulé, sans aucun appel réseau réel. Ils couvrent tous les textes dans les 5 langues, les routes et le bouton Retour, la recherche, les formulaires, la connexion et la synchronisation, l'affichage mobile, tablette et ordinateur, les animations, l'accessibilité de base, le mode hors connexion et la page 404.
