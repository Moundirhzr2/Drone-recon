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

## Profils de qualité

Le profil est choisi au démarrage d'après la carte graphique que déclare le
navigateur (`world/quality.ts`) :

| Profil      | Pour                                        | Définition          | Sol | Ombres | Anticrénelage |
| ----------- | ------------------------------------------- | ------------------- | --- | ------ | ------------- |
| `fluide`    | circuits intégrés, rendu logiciel           | 75 % des points CSS | 6   | non    | non           |
| `equilibre` | cartes dédiées d'entrée de gamme (GTX 16xx) | points CSS          | 4   | oui    | FXAA          |
| `beau`      | cartes récentes (RTX, RX 6000 et plus)      | points physiques    | 2   | douces | MSAA × 4      |

Les deux profils riches ajoutent la brume au sol et un brouillard plus léger,
qui recule l'horizon. Pour imposer un profil : `?qualite=fluide`,
`?qualite=equilibre` ou `?qualite=beau` dans l'adresse, ou
`performance.profile` dans `src/core/config.ts`.

Coût d'une image sur la GTX 1650 Max-Q, vue de départ, médiane de trois passes :

| Profil      | Image      | Coût   |
| ----------- | ---------- | ------ |
| `fluide`    | 1152 × 556 | 7,9 ms |
| `equilibre` | 1536 × 742 | 12 ms  |
| `beau`      | 1920 × 927 | 15 ms  |

Les ombres, qu'on aurait crues chères, ne coûtent qu'environ 1 ms : la carte
d'ombre ne couvre que 1,5 km autour de la caméra. La brume au sol coûte autant,
FXAA la moitié. À cette définition, le MSAA × 4 ne coûte pas plus que FXAA — c'est
pourquoi il est réservé au profil `beau`, qui rend aussi aux points physiques.

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
   chère d'abord : ombres, puis MSAA, brume au sol, FXAA. Le pilote en est
   averti dans le panneau de pilotage.

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
[perf] 31 img/s à l'échelle minimale — ombres coupées
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

## Reconstructions pendant un sinistre

Un effondrement change la géométrie — hauteur écrêtée, gravats — et pas seulement
la couleur : il faut reconstruire le bâti. Avec la première ville, générée, de 76
bâtiments, tout reconstruire coûtait 20 ms. Avec les 2 282 bâtiments réels, ce
serait plusieurs centaines de millisecondes à chaque dégât.

La ville est donc découpée en **carreaux de 100 m** — 98 au total —, chacun avec
ses propres primitives (`world/render.ts`). Chaque bâtiment a une signature
géométrique (état, gravité, gravats) ; un carreau n'est reconstruit que si l'une
des siennes a changé, et les reconstructions en attente sont étalées sur les
images suivantes, les plus proches de la caméra d'abord.

Un carreau coûte environ 3 ms à reconstruire, puis autant à sa première passe de
rendu, où Cesium assemble sa géométrie. Deux reconstructions par image faisaient
des pics de 20 ms pendant une explosion ; il n'y en a plus qu'une, et la vague de
reconstruction se lit d'ailleurs mieux ainsi, du plus proche au plus lointain.
