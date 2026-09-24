# Performance

Le HUD affiche les **images par seconde** : vert au-dessus de 50, orange entre 30
et 50, rouge en dessous.

Toutes les décisions de ce document viennent d'une mesure. Les chiffres récents
ont été relevés dans Chrome sur un portable équipé d'une **GeForce GTX 1650
Max-Q** (fenêtre de 1536 × 742 points), et d'un circuit Intel UHD pour le cas
intégré. Sur une autre machine, l'ordre de grandeur des gains reste le même, pas
les valeurs absolues.

## Ce qui a été mesuré et corrigé

| Poste                                | Constat                                          | Décision                                         |
| ------------------------------------ | ------------------------------------------------ | ------------------------------------------------ |
| Finesse du terrain                   | ~10 % du temps d'image entre les réglages 2 et 4 | réglée par profil                                |
| Test de profondeur contre le terrain | ~8 %, sans effet visible sur un sol plat         | activé avec le relief réel, où il est nécessaire |
| Matériau pointillé des polylignes    | 3,1 ms pour une ligne de deux points             | remplacé par une couleur unie                    |
| Châssis du drone en entités          | +9,2 ms par image                                | réécrit en primitive : +0,1 ms                   |
| Vue nadir                            | passe de rendu complète, ~6 ms                   | ramenée à 4 rafraîchissements par seconde        |
| Particules d'une explosion           | jusqu'à 110 ms par image                         | trois pièges de Cesium contournés : 16 à 18 ms   |
| Cache de tuiles                      | plus de 20 000 requêtes sur une vue immobile     | dimensionné par profil : 163 requêtes            |
| Découpes du relevé (ville réelle)    | 12 ms de processeur par image : 30 images/s      | carte des ruines lue par un shader : 58 images/s |
| Globe de l'IGN sous le relevé        | 6 ms par image, pour les seules découpes         | masqué, une nappe en tient lieu : 19,5 → 13 ms   |
| Murs mitoyens d'une ruine            | jusqu'à 100 ms pour une seule ruine              | côtés voisins filtrés : 3,3 ms au plus           |

## Profils de qualité

Le profil est choisi au démarrage d'après la carte graphique que déclare le
navigateur (`world/quality.ts`) :

| Profil      | Pour                                        | Définition          | Sol | Relevé | Anticrénelage |
| ----------- | ------------------------------------------- | ------------------- | --- | ------ | ------------- |
| `fluide`    | circuits intégrés, rendu logiciel           | 75 % des points CSS | 6   | 32     | non           |
| `equilibre` | cartes dédiées d'entrée de gamme (GTX 16xx) | points CSS          | 4   | 24     | FXAA          |
| `beau`      | cartes récentes (RTX, RX 6000 et plus)      | points physiques    | 2   | 12     | MSAA × 4      |

« Sol » et « Relevé » sont des finesses : l'erreur tolérée à l'écran, en pixels,
pour le relief et pour la ville photoréaliste. Plus le nombre est bas, plus
c'est net.

Les deux profils riches ajoutent la brume au sol et un brouillard plus léger,
qui recule l'horizon. Pour imposer un profil : `?qualite=fluide`,
`?qualite=equilibre` ou `?qualite=beau` dans l'adresse, ou
`performance.profile` dans `src/core/config.ts`.

Coût d'une image sur la GTX 1650 Max-Q, vue de départ, médiane de trois passes —
mesuré avec les ombres portées, désactivées depuis :

| Profil      | Image      | Coût   |
| ----------- | ---------- | ------ |
| `fluide`    | 1152 × 556 | 7,9 ms |
| `equilibre` | 1536 × 742 | 12 ms  |
| `beau`      | 1920 × 927 | 15 ms  |

Les ombres portées, qu'on aurait crues chères, ne coûtaient qu'environ 1 ms. Elles
sont pourtant désactivées : la carte d'ombre de Cesium se recale à chaque
mouvement de caméra, et ses bords scintillaient sur les façades pendant le vol.
Le mécanisme reste en place — `shadows: true` dans `world/quality.ts` suffit à
les rétablir. La brume au sol coûte environ 1 ms, FXAA la moitié. À cette
définition, le MSAA × 4 ne coûte pas plus que FXAA — c'est pourquoi il est
réservé au profil `beau`, qui rend aussi aux points physiques.

**La lumière compte autant que les réglages.** Le soleil était donné par un
vecteur écrit directement en coordonnées terrestres, et tombait sans qu'on le
choisisse à 16° au-dessus de l'horizon. Tant qu'il n'y avait pas d'ombres, cela
passait ; avec elles, les ombres portées noyaient toutes les rues. Il est
désormais placé dans le repère local : un soleil d'après-midi, au sud-ouest, à
40°.

## Le régulateur

La bonne finesse de rendu ne dépend pas du code mais de la machine : un GPU
intégré sur un écran 1920×1080 en mise à l'échelle 125 % doit couvrir **2,5 fois
plus de pixels** qu'un petit panneau de test. Le simulateur vise donc une cadence
(`performance.targetFps`, 50 par défaut) et la tient en vol :

1. il ajuste d'abord l'échelle de rendu, entre 0,4 et 1 ;
2. si la cadence manque encore à l'échelle minimale, il coupe une option, la plus
   chère d'abord : les ombres si on les a réactivées, puis le MSAA, la brume au
   sol, FXAA. Le pilote en est averti dans le panneau de pilotage.

Il ne rétablit jamais une option coupée : mieux vaut une image un peu moins riche
qu'une qualité qui clignote. L'ajustement a lieu au plus toutes les deux
secondes, parce que changer d'échelle reconstruit les tampons de rendu. Les
seuils — descente sous 40 images par seconde, remontée au-dessus de 55 — laissent
une marge contre l'oscillation. Le seuil de remontée était auparavant de 62,5 :
sur un écran à 60 Hz, qui plafonne le navigateur à 60, la résolution ne
remontait jamais.

Chaque décision est journalisée :

```
[qualité] profil equilibre (ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 with Max-Q Design …))
[perf] 22 img/s — échelle de rendu 0.75 -> 0.65
[perf] 31 img/s à l'échelle minimale — brume au sol coupée
```

Pour désactiver le régulateur : `performance.adaptiveResolution: false`. Si
c'est encore lent : `?qualite=fluide`, puis `nadir.fps: 2` — la vue verticale est
une seconde passe de rendu complète.

## Vérifier son moteur de rendu

Au démarrage, la console affiche le GPU réellement employé :

```
[gpu] moteur de rendu : ANGLE (Intel, Intel(R) UHD Graphics, Direct3D11)
```

Si le nom contient `SwiftShader`, `llvmpipe`, `software` ou
`Microsoft Basic Render Driver`, le navigateur calcule la 3D sur le processeur.
Aucune optimisation ne compensera : il faut activer l'accélération matérielle
(`chrome://settings/system`) puis redémarrer le navigateur. Le simulateur le
signale alors par un bandeau rouge en haut de l'écran.

`Microsoft Basic Render Driver` est le moteur de secours de Windows. Chrome s'y
replie quand son accélération est coupée, mais aussi, sans prévenir, après
plusieurs plantages de son processus graphique : une machine qui tournait bien la
veille peut s'y retrouver. Un redémarrage complet de Chrome le remet sur la carte
graphique.

### Ordinateurs portables à deux cartes graphiques

Beaucoup de portables associent une puce intégrée (Intel, AMD) à une carte dédiée
(NVIDIA, AMD). Par défaut, Windows attribue le navigateur à la puce intégrée,
pour économiser la batterie : le simulateur tourne alors sur la moins puissante
des deux.

Pour l'attribuer à la carte dédiée : **Paramètres Windows → Système → Écran →
Graphiques**, choisir le navigateur, **Options**, puis **Performances élevées**.
Redémarrer ensuite complètement le navigateur. La ligne `[gpu]` de la console
doit alors citer la carte dédiée.

## Effets de particules

Les effets des désastres — flammes, fumée, boule de feu, poussière — sont des
systèmes de particules de Cesium. Au premier essai, une explosion faisait tomber
la GTX 1650 à **neuf images par seconde**. Sans particules, la même image coûtait
10 ms ; avec, 110 ms. Trois pièges de Cesium, aucun documenté.

**Une copie du sprite par particule.** Cesium range l'image de chaque billboard
dans un atlas de textures, sous un identifiant tiré de son URL. Un sprite dessiné
dans un `<canvas>` n'a pas d'URL : chaque billboard en reçoit un identifiant
neuf, et chaque particule ajoutait sa propre copie du sprite à l'atlas, qui
grossissait et se recopiait sans cesse. Les sprites passent désormais en URL
`data:`, partagée par toutes les particules.

**Une particule morte n'est pas gratuite.** Quand une particule meurt, Cesium
masque son billboard pour le réutiliser. Mais le shader d'un billboard masqué
dont la taille est en mètres le ramène sur l'œil de la caméra, où il déborde
l'écran — et la carte graphique le traite quand même. Les 275 particules éteintes
d'une boule de feu coûtaient **10 ms par image**, sans rien afficher. Une échelle
nulle les rend inoffensives, et Cesium la rétablit lorsqu'il réutilise la
particule ; les systèmes arrivés au bout de leur vie sont retirés de la scène.

**Deux horloges pour une même scène.** La vue nadir rendait la scène sans lui
donner d'heure, et Cesium prenait alors l'heure système au lieu de celle de
l'horloge de la scène. Les particules, mises à jour à chaque passe, voyaient le
temps faire des bonds, et émettaient des milliers d'éléments d'un coup. La vue
nadir rend désormais au même instant que la dernière image principale.

Même instant de la même explosion (t = 2,5 s, 916 particules, 38 systèmes) :

|                   | Avant      | Après          |
| ----------------- | ---------- | -------------- |
| Image avec effets | 41 à 51 ms | **16 à 18 ms** |
| Image sans effets | 8 à 10 ms  | 9,3 ms         |

Restaient les **pics de création**. Le premier système de particules fait
compiler à Cesium ses shaders de billboards : 85 ms, au moment précis de
l'explosion. Un système invisible est donc rendu quelques images dès le
démarrage, pour payer cette compilation pendant le chargement. Et quatorze foyers
nés dans la même image coûtaient 70 ms : leur création est étalée, quatre
systèmes au plus par image.

Enfin, le budget : quatorze foyers et huit nuages de poussière au plus, les plus
proches de la caméra, à moins de 900 m. Au-delà, l'état des bâtiments suffit à
lire le sinistre.

## Le cache de tuiles

La vue principale regarde vers l'horizon, la vue nadir à la verticale : elles
n'utilisent pas les mêmes tuiles de terrain et de photo aérienne. En profil
équilibré, il en fallait 606 pour les deux ; le cache en gardait 600. Chaque
passe évinçait donc les tuiles de l'autre, qui étaient rechargées en boucle :
plus de **20 000 requêtes** en quelques minutes, sur une vue immobile, et un
chargement qui ne se terminait jamais.

La taille du cache dépend désormais du profil — 600, 1 000 et 1 500 tuiles. Même
vue, même profil : toutes les tuiles sont chargées en **2,2 s et 163 requêtes**.

## Le ciel et la distance de vue

Pour ne pas charger des centaines de kilomètres de terrain, la distance de vue de
la caméra était bornée à 22 km. Mais la coupole du ciel de Cesium est à des
centaines de kilomètres : elle disparaissait, et l'horizon était un mur noir.

C'est désormais le brouillard qui borne la distance : Cesium ne charge ni ne
dessine les tuiles entièrement noyées, et le lointain se fond dans un ciel
visible.

## La fluidité n'est pas la vitesse moyenne

Une fois le GPU dégagé, le survol restait pâteux alors que l'image médiane ne
coûtait que 3,2 ms. Le profil des temps d'image expliquait tout :

|                             | Avant     | Après         |
| --------------------------- | --------- | ------------- |
| Image médiane               | 3,2 ms    | 4,9 ms        |
| 95ᵉ centile                 | 16 ms     | **7,6 ms**    |
| Pire image                  | 59,7 ms   | **13,3 ms**   |
| Images au-dessus de 16,7 ms | plusieurs | **0 sur 110** |

La plupart des images étaient rapides, mais des pics réguliers cassaient le
mouvement. Trois corrections :

- **La vue nadir**, passe de rendu complète : l'image où elle tombait coûtait
  trois fois une image normale. Elle est désormais cadencée à 4 Hz.
- **Le pas de temps fixe**, surtout. La physique avance par pas de 1/120 s quel
  que soit le temps écoulé. C'est la correction qui change le plus la sensation
  en vol.
- **Le chargement des tuiles.** Le décodage des images satellite se fait sur le
  thread principal et provoquait les pics les plus violents : cache agrandi et
  préchargement des tuiles voisines coupé.

La médiane a légèrement monté — c'est le prix des sous-pas de physique, et il est
largement rentable.

## Le châssis du drone

Une fois réglé le problème de repère décrit dans
[l'architecture](architecture.md#le-repère-local-de-cesium), trois façons de
dessiner le drone fonctionnaient. Leur coût, image médiane complète en vue de
suivi :

| Représentation            | Image médiane | Surcoût     |
| ------------------------- | ------------- | ----------- |
| aucune                    | 2,8 ms        | —           |
| entités Cesium            | 11,0 ms       | **+9,2 ms** |
| primitive + `modelMatrix` | 2,9 ms        | **+0,1 ms** |

Les entités coûtent cher pour une raison structurelle : une position qui change à
chaque image force Cesium à reconstruire leur géométrie à chaque image. La
primitive est construite une fois ; seule sa matrice bouge.

La précision, souvent invoquée contre cette approche, ne pose pas de problème :
les sommets restent à quelques mètres de l'origine **locale**, et c'est la
`modelMatrix`, en double précision côté processeur, qui porte les 6 366 km
jusqu'au centre de la Terre.

Le châssis est depuis devenu un vrai modèle glTF — 10 912 triangles, huit
matériaux, quatre hélices animées par la matrice de leur nœud. Le principe
reste le même : rien n'est reconstruit par image. Son coût n'a pas été remesuré.

## La ville photoréaliste

Le relevé de Google est de loin le poste le plus coûteux. Image complète sur la
GTX 1650 Max-Q, carte graphique attendue à chaque image (`gl.finish`), devant le
temple Saint-Étienne, tuiles chargées :

| Finesse du relevé           | Tuiles dessinées | Image médiane | 90ᵉ centile |
| --------------------------- | ---------------- | ------------- | ----------- |
| 16, sans nadir              | 265              | 28,4 ms       | 39,7 ms     |
| 24, sans nadir              | 174              | 15,7 ms       | 18,8 ms     |
| 32, sans nadir              | 149              | 13,7 ms       | 15 ms       |
| 24, nadir en finesse moitié | 225              | 21,4 ms       | 30 ms       |
| ville dessinée, avec nadir  | —                | 14,2 ms       | 28 ms       |

La ligne « nadir en finesse moitié » est mesurée à pleine définition
(1 522 × 736), les autres à 90 % (1 369 × 612). À l'altitude d'un drone, les
finesses 16 et 24 se distinguent à peine : le profil équilibré prend 24.

**La vue nadir en finesse moitié.** Elle ne fait que quelques centaines de
pixels à l'écran, mais elle est rendue à la taille de la fenêtre : à pleine
finesse, chacun de ses rafraîchissements coûtait une seconde image entière, et
faisait charger toutes les tuiles sous le drone. Elle est désormais rendue avec
une erreur tolérée double (`PhotorealCity.coarser`). Avec les deux réglages,
l'image médiane est passée de 42,5 ms à 21,4 ms.

**La mémoire.** Par défaut, Cesium garde 1,5 Go de tuiles, plus 1 Go de
débordement : trop pour une carte de 4 Go qui dessine aussi le reste. Le cache
est dimensionné par profil (256, 512, 1 024 Mo). En vol, sur la GTX 1650, les
tuiles ont plafonné vers 700 Mo avec l'ancien réglage de 768 Mo, et la mémoire
JavaScript de la page a oscillé entre 380 et 550 Mo.

Ces mesures forcent la carte graphique à finir chaque image avant la suivante.
Elles comparent bien les réglages entre eux, mais elles ont manqué le vrai
goulot, qui n'est apparu que fenêtre visible.

**Les découpes de Cesium.** Fenêtre visible, la ville réelle plafonnait à
30 images par seconde, même immobile, même en baissant la définition à 40 % :
chaque image dépassait 16,7 ms et attendait le rafraîchissement suivant de
l'écran. En coupant les postes un par un, le temps processeur d'un rendu est
tombé de 31,6 à 19,7 ms rien qu'en désactivant les découpes des 23 ruines du
départ (`ClippingPolygonCollection`) — les tuiles, la suie et la définition ne
pesaient presque rien. Les ruines sont désormais effacées par un shader posé
sur le relevé, qui lit une carte des ruines vue de dessus (`world/photoreal.ts`) :
une lecture de texture par pixel, quel que soit le nombre de ruines.

Fenêtre visible, GTX 1650 Max-Q, pleine définition (1 522 × 680), régulateur
coupé :

| Vol                                      | Découpes de Cesium | Carte des ruines |
| ---------------------------------------- | ------------------ | ---------------- |
| Devant le temple, immobile               | 30 images/s        | 58 images/s      |
| Tour du temple                           | 19 à 23 images/s   | 58 images/s      |
| Au-dessus des 231 ruines d'une explosion | 13 à 19 images/s   | 48 à 55 images/s |

La cadence est celle de l'écran à 60 Hz : 58 images par seconde, c'est une
image manquée de temps en temps.

**Le globe resté sous le relevé.** Le relevé couvre tout le sol ; le globe de
l'IGN devait être masqué en vue réaliste, mais il ne l'était qu'au premier
changement de vue : au démarrage, il restait dessiné sous le relevé, où il ne
servait qu'à arrêter le regard au travers des découpes. Au-dessus des ruines
d'une explosion, carte graphique attendue à chaque image : 19,5 ms médians avec
lui, 13,1 ms sans. Il est désormais masqué dès le chargement, et une nappe à
nous, qui suit le relief deux mètres sous le sol (`PhotorealCity.underlayOf`),
joue ce rôle d'arrière-plan pour un coût négligeable : partout ailleurs, le sol
du relevé la cache avant qu'elle ne soit peinte.

La carte des ruines porte aussi, dans son alpha, la poussière retombée autour
des ruines : le flou des contours effacés, calculé par le même worker. Il y
ajoute quelques millisecondes, hors du fil principal, à chaque mise à jour de
la carte.

## Reconstructions pendant un sinistre

Un effondrement change la géométrie — hauteur écrêtée, gravats — et pas seulement
la couleur : il faut reconstruire le bâti. Avec la première ville, générée, de 76
bâtiments, tout reconstruire coûtait 20 ms. Avec les 2 282 bâtiments réels, ce
serait plusieurs centaines de millisecondes à chaque dégât.

La ville est donc découpée en **carreaux de 100 m** — 98 au total —, chacun avec
ses propres primitives (`world/render.ts`). Ils ne portent que le bâti debout,
construit une fois pour toutes : un changement d'état n'y change que des
couleurs. Chaque ruine a sa propre primitive, construite quand le bâtiment
tombe, et refaite seulement si sa signature change — son état, et lesquels de
ses voisins sont encore debout. Rassembler les ruines d'un carreau obligeait à
toutes les régénérer à chaque nouvelle ruine : pendant une explosion, cent
reconstructions de carreau et 2,3 s de calcul pour quatre secondes de sinistre.

Les ruines en attente sont construites les plus proches de la caméra d'abord,
dans un budget de 3 ms par image. Une ruine coûte 0,9 ms en médiane et 3,2 ms au
90ᵉ centile ; une explosion qui en fait deux cents se propage en quelques
secondes au lieu de figer l'écran, et la vague se lit d'ailleurs mieux ainsi.

**Les murs mitoyens.** Des pics de 130 à 150 ms subsistaient pendant une
explosion : une seule ruine en coûtait 102, dont 98 pour ses murs mitoyens. Pour
savoir quel voisin borde chaque tronçon de 50 cm, la distance était mesurée à
tous les côtés de tous les voisins — des milliers quand l'un d'eux est un grand
bâtiment au contour détaillé. Seuls les côtés qui passent près du tronçon sont
désormais mesurés, et sans `Math.hypot`, lent sous V8 : 3,3 ms au plus pour les
murs mitoyens d'une ruine, sur les trois cents d'une explosion.

Mesures pendant une explosion, fenêtre masquée, carte graphique attendue à
chaque image, 300 images (5 s) :

| Réglage                                  | Médiane | 90ᵉ centile | 99ᵉ centile |
| ---------------------------------------- | ------- | ----------- | ----------- |
| Budget de 3 ms, globe dessiné            | 32,4 ms | 44,6 ms     | 74 ms       |
| Globe masqué, murs mitoyens encore lents | 21 ms   | 30,9 ms     | 132 ms      |

La dernière ligne reste à remesurer avec les murs mitoyens corrigés : Chrome
gèle un onglet masqué qui calcule beaucoup, et les mesures suivantes n'ont pas
pu aller au bout.
