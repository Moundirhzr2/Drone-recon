# Performance

Le HUD affiche les **images par seconde** : vert au-dessus de 50, orange entre 30
et 50, rouge en dessous.

Toutes les décisions de ce document viennent d'une mesure. Les chiffres ont été
relevés dans Chrome, sur un panneau de test ; sur une machine plus modeste,
l'ordre de grandeur des gains reste le même, pas les valeurs absolues.

## Ce qui a été mesuré et corrigé

| Poste                                | Constat                                          | Décision                                  |
| ------------------------------------ | ------------------------------------------------ | ----------------------------------------- |
| Finesse du terrain                   | ~10 % du temps d'image entre les réglages 2 et 4 | `terrainDetail: 10` en profil `fluide`    |
| Test de profondeur contre le terrain | ~8 %, sans effet visible sur un sol plat         | désactivé hors mode `ion`                 |
| Matériau pointillé des polylignes    | 3,1 ms pour une ligne de deux points             | remplacé par une couleur unie             |
| Châssis du drone en entités          | +9,2 ms par image                                | réécrit en primitive : +0,1 ms            |
| Vue nadir                            | passe de rendu complète, ~6 ms                   | ramenée à 4 rafraîchissements par seconde |

## Résolution adaptative

La bonne finesse de rendu ne dépend pas du code mais de la machine : un GPU
intégré sur un écran 1920×1080 en mise à l'échelle 125 % doit couvrir **2,5 fois
plus de pixels** qu'un petit panneau de test. Plutôt que d'imposer une valeur, le
simulateur vise une cadence (`performance.targetFps`, 50 par défaut) et ajuste
l'échelle de rendu entre 0,4 et 1,0 pour la tenir.

L'ajustement a lieu au plus toutes les deux secondes, parce que changer d'échelle
reconstruit les tampons de rendu. La descente est franche et la remontée
prudente, pour que la résolution n'oscille pas entre deux valeurs. Chaque
changement est journalisé :

```
[perf] 22 img/s — échelle de rendu 0.75 -> 0.65
```

Pour la désactiver : `performance.adaptiveResolution: false`.

## Vérifier son moteur de rendu

Au démarrage, la console affiche le GPU réellement employé :

```
[gpu] moteur de rendu : ANGLE (Intel, Intel(R) UHD Graphics, Direct3D11)
```

Si le nom contient `SwiftShader`, `llvmpipe` ou `software`, le navigateur calcule
la 3D sur le processeur. Aucune optimisation ne compensera : il faut activer
l'accélération matérielle (`chrome://settings/system`) puis redémarrer le
navigateur. Le simulateur le signale alors dans le HUD.

## Profils

`performance.profile` dans `src/core/config.ts` :

| Profil              | Échelle de départ | Terrain | Atmosphère au sol | Distance de vue |
| ------------------- | ----------------- | ------- | ----------------- | --------------- |
| `fluide` _(défaut)_ | 0,75              | 10      | non               | 22 km           |
| `equilibre`         | 1                 | 4       | oui               | 20 km           |
| `beau`              | 1                 | 2       | oui               | 60 km           |

L'échelle de rendu est le levier le plus rentable : à 0,75, la scène est rendue
avec 44 % de pixels en moins puis agrandie. Le HUD reste net, puisqu'il est en
HTML et non dans la scène 3D.

Si c'est encore lent : `nadir.fps: 2` (la vue verticale est une seconde passe de
rendu complète) et `city.extent: 280` (moins de bâtiments).

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
la couleur : il faut reconstruire le bâti.

```
reconstruction complète (76 bâtiments) ...... 19,7 ms
  dont création des 300 boîtes .............  1,6 ms
```

Le coût est presque entièrement dans la construction de la primitive par Cesium —
fusion des instances, sphères englobantes, envoi au GPU — et il est
incompressible de notre côté.

Pendant la lecture, les événements arrivent à environ cinq par seconde. Les
reconstructions sont donc regroupées par fenêtres de 300 ms, retard imperceptible
sur un sinistre de trente secondes. Hors lecture — boutons Avant/Après, curseur,
annulation — la reconstruction reste immédiate, parce que la réactivité prime.

Mesure en temps réel, séisme joué à **double vitesse**, donc avec un débit
d'événements deux fois pire que la normale : médiane 1,1 ms, 95ᵉ centile 2,7 ms,
et 17 images sur 813 au-dessus de 16,7 ms.
