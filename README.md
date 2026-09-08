# OneTwoFreelance — MCP Tech Jobs

Petit pipeline qui collecte des offres freelance/contract dans la tech en Europe (EURES + Arbeitnow), les enrichit avec l'IA (compétences, séniorité, mode de travail, résumé...), puis les expose de deux façons :

- une **interface web** consultable dans un navigateur (recherche, filtres, favoris) ;
- un **serveur MCP** interrogeable par un assistant IA (Claude, etc.) via deux outils : `search_jobs` et `get_job`.

**Serveur MCP déployé :** https://mcp-tech-jobs.onrender.com (endpoint MCP : `POST /mcp`)

## Comment ça marche

Le projet fonctionne en 3 étapes indépendantes, chacune avec son propre script :

```
1. npm run fetch      → récupère les offres brutes (EURES + Arbeitnow)
                          et les enregistre dans data/raw_jobs.json

2. npm run structure   → envoie chaque offre à gpt-4o-mini pour en extraire
                          les compétences, la séniorité, le mode de travail...
                          et sauvegarde le résultat dans data/structured_jobs.json

3. npm run web         → sert l'interface web à partir des données enrichies
   npm run dev:mcp     → démarre le serveur MCP à partir des mêmes données
```

Les étapes 1 et 2 ne tournent pas en continu : ce sont des scripts ponctuels à relancer quand on veut rafraîchir les données. Les étapes 3 servent le résultat déjà généré.

## Installation

Prérequis : Node.js 18+ et une clé API OpenAI.

```bash
npm install
```

Créer un fichier `.env` à la racine avec :

```
OPENAI_API_KEY=sk-...
PORT=3000        # optionnel, port du serveur MCP (défaut 3000)
WEB_PORT=3100    # optionnel, port de l'interface web (défaut 3100)
```

## Utilisation

Générer les données (à faire une première fois, puis à chaque rafraîchissement) :

```bash
npm run fetch
npm run structure
```

Puis lancer l'un des deux serveurs :

```bash
npm run web       # interface web sur http://localhost:3100
npm run dev:mcp   # serveur MCP sur http://localhost:3000 (endpoint POST /mcp)
```

## Structure du projet

```
src/
  fetch_raw.ts       # récupère et filtre les offres tech depuis EURES + Arbeitnow
  structure_jobs.ts  # enrichit chaque offre via OpenAI (structured outputs)
  mcp_server.ts       # serveur MCP (outils search_jobs / get_job)
  web_server.ts       # petit serveur Express qui injecte les données dans public/index.html
public/
  index.html          # interface web (HTML/CSS/JS, sans framework)
data/
  raw_jobs.json        # sortie de l'étape "fetch"
  structured_jobs.json # sortie de l'étape "structure" (utilisée par le web et le MCP)
```

## Outils MCP exposés

- **`search_jobs`** — recherche par mot-clé, catégorie, séniorité, mode de travail ou type de contrat.
- **`get_job`** — retourne le détail complet d'une offre à partir de son `id`.

## Sources et limites

- **EURES** : filtré nativement côté serveur sur les offres "selfemployed", puis filtré côté client sur des mots-clés tech (titre + description).
- **Arbeitnow** : pas de filtre serveur freelance/tech disponible, donc tout le filtrage (contrat + domaine tech) se fait côté client.
- Le dédoublonnage se fait par URL et par titre normalisé, toutes sources confondues.
- `npm run build` compile `src/` vers `dist/` (utilisé par `npm start`, qui lance `dist/mcp_server.js`).
