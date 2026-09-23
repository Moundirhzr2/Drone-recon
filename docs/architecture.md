# Architecture

## Organisation du code

```
src/
├── core/         configuration, bus d'événements, maths (One Euro, géodésie, PRNG)
├── world/        scène Cesium, ville réelle (IGN) et ville générée de secours,
│                 relief, états de dommage, rendu du bâti par carreaux, textures,
│                 courbe de fragilité, profils de qualité
├── drone/        physique de vol, châssis 3D, caméras, vue nadir, photos
├── input/        abstraction des commandes, clavier, suivi des mains MediaPipe
├── diagnostic/   détecteur de dommages, surcouches, métriques
├── disaster/     scénarios, champs d'intensité, chronologie et lecture
├── effects/      effets visuels des désastres : eau, feu, fumée, explosion
├── hud/          panneaux de l'interface et feuille de style
└── main.ts       assemblage et boucle principale

scripts/          téléchargement des bâtiments et du relief depuis l'IGN
public/data/      les mêmes, figés et versionnés (voir données)
```

Les dépendances vont dans un seul sens : `core` ne dépend de rien, `world` de
`core`, et les modules de haut niveau (`drone`, `disaster`, `effects`, `hud`)
s'appuient sur les précédents. Aucun cycle d'import.

La ville réelle est chargée au démarrage depuis `public/data/` ; si le fichier
manque, la ville générée prend le relais, et tout le reste fonctionne à
l'identique. Le détail des données est dans [données](donnees.md).

## Une image, du début à la fin

La boucle de rendu par défaut de Cesium est désactivée ; `main.ts` pilote chaque
image dans cet ordre :

| #   | Étape                              | Cadence              | Pourquoi à cette place                                      |
| --- | ---------------------------------- | -------------------- | ----------------------------------------------------------- |
| 1   | Redimensionnement du canvas        | ≤ 2 Hz               | `viewer.render()` ne le fait pas lui-même                   |
| 2   | Physique du drone                  | pas fixe de 1/120 s  | indépendante de la cadence d'affichage                      |
| 3   | Pose du châssis, puis de la caméra | chaque image         | la caméra suit le drone déjà déplacé                        |
| 4   | Simulateur de désastres            | chaque image         | peut marquer des carreaux du bâti à reconstruire            |
| 5   | Effets visuels, secousse           | chaque image         | suivent le temps du sinistre ; la secousse, la caméra posée |
| 6   | Vue nadir (seconde passe de rendu) | 4 Hz                 | poste le plus coûteux après le rendu principal              |
| 7   | Rendu principal                    | chaque image         |                                                             |
| 8   | Carreaux et couleurs en attente    | un carreau par image | une primitive n'accepte ses attributs qu'une fois compilée  |
| 9   | Surcouche de diagnostic            | 8 Hz                 | projetée avec la caméra qui vient de servir au rendu        |
| 10  | Qualité adaptative                 | ≤ 0,5 Hz             | voir [performance](performance.md#le-régulateur)            |
| 11  | Panneaux du HUD                    | 10 Hz                | réécrire le DOM à 60 Hz coûterait plus que la scène         |

Le pas fixe de l'étape 2 est ce qui rend le vol fluide : sans lui, une image de
40 ms ferait bondir le drone de quatre fois la distance d'une image de 10 ms.

## Trois décisions qui expliquent le reste du code

**`preserveDrawingBuffer: true`** (`world/viewer.ts`). Sans cette option, lire le
canvas WebGL — pour la vue nadir ou une photo — renvoie une image noire. Elle ne
se règle qu'à la création du viewer, et c'est le piège le plus courant du projet.

**Une seule scène, deux passes de rendu** (`drone/nadir.ts`). Plutôt qu'un second
viewer Cesium, qui doublerait la mémoire GPU et rechargerait toutes les tuiles,
on pointe la caméra à la verticale, on rend, on copie le carré central, puis on
remet la caméra. C'est ce qui impose de désactiver la boucle de Cesium : il
fallait un point d'accroche entre les deux passes. La passe nadir rend au même
instant que la dernière image principale : sans heure fournie, Cesium prendrait
l'heure système, et les particules verraient le temps faire des bonds.

**Une couche d'abstraction des commandes** (`input/control.ts`). Le drone reçoit
quatre nombres et ignore d'où ils viennent. On développe au clavier, on démontre
aux mains, et les sources s'additionnent : on peut corriger une trajectoire au
clavier tout en pilotant aux gestes.

## Le repère local de Cesium

`Transforms.headingPitchRollToFixedFrame` s'appuie par défaut sur
`eastNorthUpToFixedFrame`. Le cap fait donc tourner un repère Est/Nord/Haut, et
les axes qui en sortent sont :

```
X = DROITE      Y = AVANT      Z = HAUT
```

Ce n'est **pas** la convention aéronautique (X vers l'avant) qu'on attend
spontanément. Toutes les positions locales du projet — recul de la caméra de
suivi, œil de la vue embarquée, pièces du châssis — suivent cette convention, et
elle est rappelée en tête de `drone/camera.ts`.

### Pourquoi ce point mérite sa section

Pendant une bonne partie du développement, le châssis 3D du drone a été réputé
impossible à afficher. Trois approches — entités, primitives, polylignes —
semblaient ne produire aucun pixel, alors que les positions étaient vérifiées
correctes. On en avait conclu à un problème de précision en virgule flottante.

Le diagnostic était faux. Le châssis se dessinait depuis le début : c'est la
caméra de suivi qui se plaçait à côté de lui. Son recul était écrit
`(-distance, 0, lift)`, soit 26 m vers la **gauche** au lieu de 26 m vers
l'**arrière**.

Ce genre d'erreur ne produit aucun message. La caméra vise juste, sa distance est
juste, la sphère englobante de l'objet est au bon endroit : tout est correct sauf
l'azimut. Il a fallu mesurer l'angle entre l'axe de visée et la direction du
drone pour le voir :

```
écart entre l'axe de visée et le drone
  avant correction .... 90,1°
  après correction ....  0,08°
```

Une fois la caméra corrigée, le choix de représentation du châssis a enfin pu se
faire sur son vrai critère, le coût — voir [performance](performance.md#le-châssis-du-drone).

## Textures du bâti

Les façades ne sont pas une image plaquée mais un motif calculé dans le fragment
shader (`world/facade.ts`).

**Pourquoi pas une image.** Les coordonnées de texture d'un cube vont de 0 à 1
par face, quelle que soit sa taille. Un pavillon de 8 m et une tour de 96 m
recevraient le même nombre de rangées de fenêtres, et l'échelle du quartier —
précisément ce qu'un pilote de reconnaissance doit lire — deviendrait illisible.
Le shader reçoit donc les dimensions réelles et pose une travée tous les 3,4 m et
un étage tous les 3,2 m : un immeuble de 30 m montre neuf étages parce qu'il en
a neuf.

**Pourquoi une apparence maison.** `MaterialAppearance` porterait une texture,
mais ignore la couleur par instance, qui porte tout le reste du projet : teintes
par usage, états de dommage, et surtout la vue diagnostique qui recolore les
bâtiments un par un. Le shader garde donc cette couleur et la multiplie par le
motif.

Quatre surfaces sont reconnues — façade, toiture, gravats et façade incendiée,
aux baies vides et noircies de suie — et la vue diagnostique repasse en aplat,
parce qu'une trame de fenêtres sous une couleur de classification brouillerait
la lecture. Les vitrages reflètent le ciel, plus ou moins clair d'une fenêtre à
l'autre ; une sur cinq a ses rideaux tirés.

Les bâtiments réels sont extrudés depuis leur contour IGN : un mur par arête, dont
les coordonnées de texture suivent la longueur réelle, et un toit triangulé par
[earcut](https://github.com/mapbox/earcut), qui respecte les cours intérieures.

### Deux contraintes de Cesium à connaître

1. **Les shaders sont en GLSL ES 3.00**, comme ceux de Cesium : `in`, `out`,
   `out_FragColor`. Écrire `attribute` ou `varying` échoue à la compilation.

2. **Un attribut par instance au nom inédit est refusé.** Les attributs par
   instance passent par la table de lots de Cesium, qui ne connaît qu'une liste
   fermée de noms (`color`, `show`...). Les dimensions voyagent donc dans un
   attribut **de géométrie**, qui accepte n'importe quel nom. Seule la couleur
   reste modifiable à chaud, d'où l'usage de son canal alpha comme interrupteur
   entre texture et aplat.

## Inspecter la simulation depuis la console

`window.__sim` expose l'état interne dans la console du navigateur :

```js
__sim.drone.state; // position, vitesses, cap, batterie
__sim.city.buildings; // les 2 282 bâtiments et leur état réel
__sim.nadir.geometry; // géométrie de la dernière prise de vue
__sim.analyse(__sim.city.buildings, __sim.nadir.geometry); // détections et métriques
__sim.player.current; // chronologie du sinistre chargé
__sim.gpu; // moteur de rendu réellement utilisé
__sim.quality.profile; // profil de qualité retenu
__sim.effects; // effets visuels en cours
__sim.step(); // avance la simulation d'une image
```

`step()` existe parce que le navigateur gèle `requestAnimationFrame` dès que
l'onglet passe en arrière-plan : la scène reste alors inspectable et pilotable à
la main.
