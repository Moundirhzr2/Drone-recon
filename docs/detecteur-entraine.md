# Détecteur entraîné

![Le modèle entraîné sur la caméra nadir, après un séisme : boîtes et scores du modèle, et le rapport qui le confronte à la vérité du simulateur](images/12-detecteur-entraine.jpg)

La touche `O` remplace le [détecteur simulé](diagnostic.md) par un vrai modèle
de vision : un YOLO entraîné sur les images que le simulateur exporte, exécuté
dans le navigateur sur l'image de la caméra nadir. Un second appui revient au
détecteur simulé.

Le rapport de diagnostic reste le même, et c'est tout l'intérêt : la précision
et le rappel affichés en vol sont désormais ceux d'un vrai modèle, mesurés en
direct contre la vérité du simulateur.

## La chaîne complète

| Étape              | Outil                                                | Ce qu'elle produit                                       |
| ------------------ | ---------------------------------------------------- | -------------------------------------------------------- |
| 1. Images annotées | touche `J`, voir [jeu de données](jeu-de-donnees.md) | 1 044 images de 640 px, 8 328 bâtiments annotés          |
| 2. Préparation     | `ml/preparer.py`                                     | séparation entraînement / validation, classes fusionnées |
| 3. Entraînement    | `ml/entrainer.py`                                    | YOLO11n entraîné sur la carte graphique                  |
| 4. Mesure          | `ml/evaluer.py`                                      | scores au réglage du simulateur, matrice de confusion    |
| 5. Export          | `ml/exporter.py`                                     | `public/models/detecteur.onnx` (10,6 Mo) et sa fiche     |
| 6. Exécution       | `src/diagnostic/model.ts`                            | le modèle dans le navigateur, touche `O`                 |

Les commandes sont dans la [notice de `ml/`](../ml/README.md).

### Préparation

La validation est séparée **par emplacement**, pas par image. Une même case du
balayage est photographiée pour les quatre aléas : mélanger ces images entre
entraînement et validation ferait valider le modèle sur des rues qu'il a déjà
vues. Une case sur cinq part en validation, avec ses quatre images.

La classe « fissuré » est fusionnée avec « intact ». Dans la ville dessinée, un
bâtiment fissuré est rendu exactement comme un intact : demander au modèle de
les distinguer reviendrait à lui apprendre à deviner.

|              | Images | Intact | Partiel | Effondré | Incendié |
| ------------ | -----: | -----: | ------: | -------: | -------: |
| Entraînement |    836 |  6 386 |     256 |      105 |      115 |
| Validation   |    208 |  1 335 |      55 |       27 |       49 |

Les dégâts sont rares : un bâtiment annoté sur quatorze. Le modèle voit bien
plus de toits intacts que de ruines, et c'est ce qui rend l'exercice difficile.

### Entraînement

YOLO11n, le plus petit des modèles YOLO récents (2,6 millions de paramètres),
part de poids préentraînés sur COCO. Il tient dans les 4 Go d'une GTX 1650 et
tourne ensuite dans un navigateur.

60 passes en 640 px, par lots de 16, en un peu moins de deux heures sur une
GTX 1650 Max-Q de portable. La demi-précision est coupée : elle donne des
pertes NaN sur les cartes GTX 16xx. Les images étant prises à la verticale,
le retournement haut-bas s'ajoute au gauche-droite parmi les augmentations.

Les poids retenus sont ceux de la passe 48, la meilleure en mAP50-95.

## Résultats

### Validation

Mesures d'Ultralytics sur les 208 images de validation, tous seuils de
confiance confondus :

| Classe       | Bâtiments | Précision | Rappel |    mAP50 | mAP50-95 |
| ------------ | --------: | --------: | -----: | -------: | -------: |
| Intact       |     1 335 |      0,88 |   0,81 |     0,89 |     0,71 |
| Partiel      |        55 |      0,69 |   0,56 |     0,62 |     0,43 |
| Effondré     |        27 |      0,90 |   0,41 |     0,50 |     0,27 |
| Incendié     |        49 |      0,76 |   0,84 |     0,85 |     0,58 |
| **Ensemble** |     1 466 |      0,81 |   0,66 | **0,71** | **0,50** |

### Au réglage du simulateur

Le mAP balaie tous les seuils ; en vol, le simulateur ne garde que les boîtes
au-dessus de 30 % de confiance. `ml/evaluer.py` refait sur la validation
exactement le calcul du simulateur : même seuil, fusion des boîtes sans tenir
compte de la classe, rapprochement d'une boîte et d'un bâtiment à partir de
50 % de recouvrement.

| Prédit \ réel |    Intact | Partiel | Effondré | Incendié | Rien |
| ------------- | --------: | ------: | -------: | -------: | ---: |
| Intact        | **1 165** |       0 |        0 |        0 |  304 |
| Partiel       |         0 |  **34** |        5 |        0 |   18 |
| Effondré      |         0 |       0 |    **8** |        0 |    0 |
| Incendié      |         3 |       0 |        0 |   **44** |   13 |
| Rien          |       167 |      21 |       14 |        5 |      |

Lues comme dans le rapport du simulateur, où une alerte est une boîte d'une
classe de dégâts :

| Mesure                | Valeur | Question                                                           |
| --------------------- | -----: | ------------------------------------------------------------------ |
| Précision des alertes |   73 % | parmi 125 alertes, 91 tombent sur un bâtiment réellement endommagé |
| Rappel                |   69 % | parmi 131 dégâts réels, 91 sont signalés                           |
| Classe juste          |   95 % | parmi ces 91, 86 reçoivent la bonne classe                         |

Ce que la matrice dit du modèle :

- **L'incendie se voit bien** : 90 % des bâtiments incendiés sont trouvés. Le
  toit noirci est sans doute la signature la plus franche du rendu.
- **Un dégât n'est presque jamais pris pour un bâtiment intact.** Les erreurs
  sont des oublis (ligne « rien ») ou des confusions entre classes de dégâts
  voisines, partiel et effondré.
- **L'effondrement est le point faible** : 8 sur 27 seulement. Quand le modèle
  annonce un effondrement, il a raison, mais il en manque 14 et en prend 5 pour
  des effondrements partiels. Un tas de gravats bas et étalé ressemble
  probablement trop au sol ; c'est aussi la classe la moins représentée, avec
  105 exemples à l'entraînement.
- **Les fausses alertes sont surtout des erreurs de cadrage** : 23 des 34
  recouvrent bien un bâtiment, mais à moins de 50 %. Comme dans le calcul du
  mAP50, une telle boîte compte comme fausse. En vol, le rapport nomme quand
  même le bâtiment visé, suivi de « boîte imprécise ».

Avec 27 effondrements répartis sur six images, ces chiffres ont une forte marge
d'incertitude. Ils disent un ordre de grandeur, pas une performance à la
décimale près.

## Dans le navigateur

### Exécution

Le modèle exporté en ONNX tourne avec
[ONNX Runtime Web](https://onnxruntime.ai), dans un worker : son calcul ne
bloque jamais la boucle de rendu. Il passe par la carte graphique (WebGPU)
quand elle est disponible, en demandant la plus puissante sur un portable qui
en a deux, et sinon par le processeur (WebAssembly).

| Mesure, GTX 1650 Max-Q                     | Valeur                                                              |
| ------------------------------------------ | ------------------------------------------------------------------- |
| Une analyse, carte graphique (WebGPU)      | 46 à 66 ms, préparation de l'image comprise                         |
| Une analyse, processeur seul (WebAssembly) | 3 à 5 s                                                             |
| Cadence de la 3D, modèle actif ou non      | 57 images/s dans les deux cas (Chrome sans fenêtre, drone immobile) |

Le modèle reçoit l'image de la passe de rendu nadir, recopiée à 640 px : il
n'y a pas de rendu en plus. Une image ne lui est envoyée que s'il a fini la
précédente, au plus quatre fois par seconde, au rythme de la caméra nadir.

Le moteur WebAssembly (27 Mo) et le modèle (10,6 Mo) ne sont téléchargés qu'au
premier appui sur `O`.

### Ce que voit le modèle

Il voit la scène comme à l'entraînement : la ville dessinée d'après l'IGN,
sans fumée, flammes ni eau, et sans les couleurs de la vue diagnostique, qui
lui souffleraient la réponse. La touche `O` bascule donc la vue dans ce rendu.
Le relevé photoréaliste de Google n'est jamais analysé : ses conditions
d'utilisation l'interdisent, et le modèle n'a jamais vu ces images.

### Vérifications

- **Décodage.** Sur une même image, le navigateur et Ultralytics trouvent les
  mêmes 24 boîtes, avec les mêmes classes et les mêmes scores.
- **Cap du drone.** Les images d'entraînement ont le nord en haut ; en vol,
  l'image tourne avec le drone. Au-dessus d'un même foyer de dégâts, à 0°, 45°
  et 90° de cap, la précision reste entre 86 et 100 % et le rappel entre 67 et
  75 %. Un seul lieu ne prouve rien en général, mais aucune chute n'apparaît.

## Limites

- **Images de synthèse.** Le modèle n'a vu que la ville dessinée. Il reste à
  le mesurer sur de vraies images de drone, où l'écart entre simulation et
  réalité sera la vraie question.
- **Une seule hauteur.** Toutes les images d'entraînement sont prises à 60 m.
  Loin de cette hauteur, les bâtiments n'ont plus la taille que le modèle
  connaît ; le rapport le signale au-delà de 20 m d'écart.
- **Pas de fissures.** Ce rendu ne les montre pas, le modèle ne les cherche
  donc pas, et le rapport les compte comme intactes.
- **Peu d'exemples de dégâts**, et une validation trop petite pour mesurer
  finement l'effondrement.
- **Un léger retard.** Les boîtes affichées sont celles de la dernière analyse
  terminée, soit une fraction de seconde de retard sur l'image.

## Brancher un autre modèle

Le simulateur ne connaît du modèle que deux fichiers, dans `public/models/` :
`detecteur.onnx` et sa fiche `detecteur.json`.

```json
{
  "name": "YOLO11n — Drone Recon",
  "format": "yolo",
  "inputSize": 640,
  "classes": ["intact", "partial", "collapsed", "burnt"],
  "trainedAltitude": 60,
  "epoch": 48,
  "validation": { "mAP50": 0.711, "mAP50-95": 0.497, "precision": 0.808, "recall": 0.655 }
}
```

- **Entrée** : une image carrée `[1, 3, taille, taille]`, en RVB, de 0 à 1.
- **Sortie au format `yolo`** : un tenseur `[1, 4 + classes, ancres]`, soit le
  centre et la taille de chaque boîte en pixels, puis un score par classe. C'est
  la sortie des modèles Ultralytics exportés sans post-traitement (`nms=False`).
- **Classes** : nommées comme les états du simulateur (`intact`, `cracked`,
  `partial`, `collapsed`, `burnt`), dans l'ordre des sorties du modèle.

Un autre détecteur à ce format se branche en remplaçant ces deux fichiers, sans
toucher au code. Un format de sortie différent demande seulement d'écrire son
décodage, sur le modèle de `src/diagnostic/yolo.ts` : le rapprochement avec la
vérité, l'affichage et les métriques ne changent pas.
