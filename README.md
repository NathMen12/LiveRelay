# LiveRelay

Application web de live streaming audio/vidéo, **sans WebRTC pair-à-pair**. Le flux part du navigateur de l'hôte, transite par un serveur Node.js, puis est redistribué aux spectateurs en WebM/MSE (ordinateur) ou en HLS (iPhone/Safari).

```
Hôte (getDisplayMedia + MediaRecorder) → WebSocket binaire → Serveur Node.js → WebSocket binaire → MSE (desktop)
                                  └────────────────────────────────────────────→ HLS (iPhone/Safari)
```

## Fonctionnalités

- Liste des lives en cours, mise à jour en temps réel : titre, hôte, spectateurs, résolution/fps, durée.
- Création d'un live : titre, pseudo, résolution (480p, 720p, 1080p, 1440p), fps (15, 24, 30, 60), bitrate auto ou manuel.
- **Capture directe par défaut** : `MediaRecorder` sur la piste `getDisplayMedia`. La résolution/fps réels sont affichés ; le canvas n'est qu'une option explicite.
- Micro optionnel, audio système optionnel, aperçu local.
- HUD hôte : résolution demandée/réelle, fps demandés/réels, bitrate cible/envoyé, spectateurs, durée.
- **Hôte résilient** : auto-reconnexion avec 15 s de grâce, reprise du live sans perdre les spectateurs.
- **Reprise du partage** : si la piste d'écran se termine, un bouton « Reprendre le partage » relance la capture et redémarre le flux.
- **iPhone/Safari** : packaging HLS côté serveur (H.264/AAC) via ffmpeg, lecture HLS native.
- **Desktop** : WebM/MSE basse latence, buffer 2 s, rattrapage du direct.
- Spectateur : compteur, état en direct/reconnexion/terminé, contrôles custom, reconnexion auto.
- Interface sombre responsive, sans build.

## Stack

- **Backend** : Node.js, Express 5, `ws`, `ffmpeg-static`.
- **Frontend** : HTML/CSS/JavaScript vanilla.
- **Capture** : `getDisplayMedia`, `getUserMedia`, `MediaRecorder` (WebM VP8/VP9 + Opus).
- **Lecture** : MediaSource Extensions (desktop) / HLS natif (iPhone/Safari).
- **Persistance** : aucune, état en mémoire.

## Prérequis

- Node.js **20+** (testé avec Node 26).
- Navigateur **Chrome ou Edge sur ordinateur** recommandé pour l'hôte.
- **HTTPS ou localhost** pour `getDisplayMedia`. En local, utilisez `http://localhost:3000`.
- `ffmpeg-static` est installé automatiquement avec `npm install` (~80 Mo).

## Installation et lancement

```powershell
npm install
npm start
```

Puis ouvrez <http://localhost:3000>.

Pour changer le port :

```powershell
$env:PORT=8080; npm start
```

Variables utiles :

- `PORT` : port HTTP/WebSocket (défaut 3000).
- `HLS_DISABLED=1` : désactive le packaging HLS.
- `HLS_ROOT` : dossier de sortie HLS (défaut : dossier temporaire).
- `HOST_RESUME_GRACE_MS` : durée de grâce hôte (défaut 15000).
- `HOST_NO_DATA_TIMEOUT_MS` : arrêt après absence de chunks (défaut 120000).

## Tester avec deux onglets

1. Ouvrez `http://localhost:3000` dans un premier onglet.
2. Cliquez sur **Créer un live**, saisissez un titre et un pseudo, choisissez résolution/fps, puis **Partager l'écran et lancer le live**.
3. Dans le sélecteur du navigateur, choisissez un onglet, une fenêtre ou un écran. Cochez éventuellement le micro et l'audio système.
4. Ouvrez un deuxième onglet sur `http://localhost:3000` et cliquez **Rejoindre**.
5. Testez un troisième onglet après quelques secondes : il doit recevoir l'init segment puis le direct.
6. Depuis l'onglet hôte, cliquez **Arrêter le live** : les spectateurs reçoivent la fin et reviennent à la liste.
7. Testez la reconnexion : coupez le réseau du spectateur (DevTools) puis rétablissez-le.
8. Testez la reprise : partagez une fenêtre, arrêtez le partage via le navigateur, puis cliquez **Reprendre le partage**.

### iPhone

- Ouvrez `http://<IP-du-serveur>:3000` depuis l'iPhone (le serveur écoute sur toutes les interfaces).
- L'hôte doit utiliser `http://localhost:3000` pour que `getDisplayMedia` fonctionne.
- Le lecteur détecte Safari/iOS et utilise le HLS natif. Si le HLS n'est pas prêt, il attend et réessaie.

### Forcer le transport (debug)

- `watch.html?live=<id>&transport=mse` : force WebM/MSE.
- `watch.html?live=<id>&transport=hls` : force HLS.

## Structure

```
LiveRelay/
├─ server.js
├─ lib/
│  ├─ config.js
│  ├─ protocol.js
│  ├─ registry.js
│  ├─ hls-transcoder.js
│  └─ ws-handler.js
├─ public/
│  ├─ index.html
│  ├─ create.html
│  ├─ watch.html
│  ├─ css/styles.css
│  └─ js/{common,home,create,watch}.js
├─ test/
├─ docs/
└─ worklog.md
```

## Scripts npm

- `npm start` : démarre le serveur.
- `npm run dev` : redémarrage automatique via `node --watch`.
- `npm test` : tests unitaires, intégration WebSocket et packaging HLS.
- `npm run check` : vérification syntaxique de tous les fichiers JS.

## API HTTP

- `GET /api/lives` : liste des lives + `serverNow`.
- `GET /api/health` : état du serveur (nombre de lives, connexions, HLS).
- `GET /hls/<liveId>/index.m3u8` : playlist HLS.
- `GET /hls/<liveId>/segment*.ts` : segments HLS.

## Limites par défaut

- 20 lives simultanés.
- 100 spectateurs par live.
- 300 connexions WebSocket.
- Chunks WebM de 4 Mo maximum.
- 8 transcodages HLS concurrents maximum.
- Aucune persistance : un redémarrage du serveur supprime les lives.

## Limites connues

- Chrome/Edge sont la cible principale ; Firefox est best-effort ; Safari/iOS utilise HLS.
- `getDisplayMedia` n'est pas disponible sur mobile.
- L'audio système dépend du navigateur et du système d'exploitation.
- Latence desktop WebM : 1 à 3 s ; iPhone HLS : 3 à 5 s.
- Le premier démarrage HLS peut prendre quelques secondes (ffmpeg transcode).
- Une erreur de décodage MSE déclenche une reconnexion automatique (max 10 avant erreur fatale).
- WebM live ne permet pas le seek/DVR ; la lecture reste au bord du direct.
- Le mode canvas peut être coûteux et sensible à la mise en arrière-plan.
- Pas de chat, pas d'enregistrement, pas d'authentification multi-utilisateur.

## Sécurité

- Token hôte aléatoire de 32 octets, transmis à la création.
- Seul le socket hôte authentifié peut envoyer des chunks binaire.
- Validation de tous les messages, limites de taille, rate-limit, vérification d'origine WebSocket.
- Nettoyage des lives, spectateurs, buffers, transcodages ffmpeg et timers à la fermeture.
- Aucun secret dans le dépôt.

## Documentation

- [Architecture](docs/architecture.md)
- [Protocole WebSocket](docs/protocol.md)
- [Choix techniques](docs/technical-choices.md)
- [Worklog](worklog.md)