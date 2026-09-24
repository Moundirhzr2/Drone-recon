# Architecture

## Organisation du code

```
src/
├── core/         configuration, bus d'événements, maths (One Euro, géodésie, PRNG)
├── world/        scène Cesium, ville réelle (IGN) et ville générée de secours,
│                 ville photoréaliste (Google), relief, états de dommage, rendu du
│                 bâti par carreaux, textures, courbe de fragilité, profils de
│                 qualité
├── drone/        physique de vol, châssis 3D, caméras, vue nadir, photos
├── input/        abstraction des commandes, clavier, suivi des mains MediaPipe
├── diagnostic/   détecteur de dommages, surcouches, métriques
├── disaster/     scénarios, champs d'intensité, chronologie et lecture
├── effects/      effets visuels des désastres : eau, feu, fumée, explosion
├── hud/          panneaux de l'interface et feuille de style
├── demo/         visite guidée, lancée par ?demo dans l'adresse
└── main.ts       assemblage et boucle principale

scripts/          téléchargement des bâtiments et du relief depuis l'IGN,
                  génération du modèle 3D du drone
public/data/      bâtiments et relief, figés et versionnés (voir données)
public/models/    le drone, en glTF
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

| #   | Étape                              | Cadence             | Pourquoi à cette place                                       |
| --- | ---------------------------------- | ------------------- | ------------------------------------------------------------ |
| 1   | Redimensionnement du canvas        | ≤ 2 Hz              | `viewer.render()` ne le fait pas lui-même                    |
| 2   | Physique du drone                  | pas fixe de 1/120 s | indépendante de la cadence d'affichage                       |
| 3   | Pose du châssis, puis de la caméra | chaque image        | la caméra suit le drone déjà déplacé                         |
| 4   | Simulateur de désastres            | chaque image        | peut marquer des ruines à construire, des carreaux à peindre |
| 5   | Effets visuels, secousse           | chaque image        | suivent le temps du sinistre ; la secousse, la caméra posée  |
| 6   | Vue nadir (seconde passe de rendu) | 4 Hz                | poste le plus coûteux après le rendu principal               |
| 7   | Rendu principal                    | chaque image        |                                                              |
| 8   | Ruines et couleurs en attente      | 3 ms par image      | une primitive n'accepte ses attributs qu'une fois compilée   |
| 9   | Surcouche de diagnostic            | 8 Hz                | projetée avec la caméra qui vient de servir au rendu         |
| 10  | Qualité adaptative                 | ≤ 0,5 Hz            | voir [performance](performance.md#le-régulateur)             |
| 11  | Panneaux du HUD                    | 10 Hz               | réécrire le DOM à 60 Hz coûterait plus que la scène          |

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

**Une façade par époque.** Le shader reçoit, pour chaque bâtiment, son époque
de construction, son usage et une graine tirés de la BD TOPO®. Avant 1914 :
enduits pastel, encadrements de pierre, volets battants, bandeaux d'étage,
chaînages d'angle — la vieille ville de Mulhouse. De 1914 à 1974 : volets
roulants plus ou moins baissés, balcons. Après 1974 : bandeaux vitrés, et
murs-rideaux pour les bureaux. Les immeubles commerçants ont leurs vitrines et
leurs enseignes au rez-de-chaussée, l'édifice religieux ses baies en plein
cintre. Les vitrages reflètent le ciel d'autant plus qu'on les regarde de biais.

**Une toiture par couverture.** La BD TOPO® déclare aussi le matériau de
couverture et, par l'écart entre faîte et gouttière, la forme du toit : tuiles
en rangs décalés, ardoises, zinc à joints debout, terrasse gravillonnée avec
ses édicules techniques, verrière. Quand le matériau manque, il est déduit de
la forme. Les rangs de tuiles suivent le plus grand côté du toit, comme une
ligne d'égout.

**Des motifs filtrés.** Un motif calculé n'a pas de mipmaps : quand une fenêtre
ou un rang de tuiles ne couvre plus que quelques pixels, il saute d'un pixel à
l'autre au moindre mouvement et la ville scintille. Chaque motif se fond donc
vers sa teinte moyenne à mesure qu'il rétrécit à l'écran, et chaque bord est
lissé sur un pixel. Les valeurs propres à un bâtiment sont arrondies avant tout
tirage au sort : interpolées d'un pixel à l'autre avec d'infimes écarts, elles
faisaient tirer à chaque pixel une valeur différente.

Sept surfaces sont reconnues — façade, toiture, gravats, façade incendiée aux
baies vides et noircies de suie, toiture réelle, mur mis à nu, aplat — et la vue
diagnostique repasse en aplat, parce qu'une trame de fenêtres sous une couleur
de classification brouillerait la lecture.

Les bâtiments réels sont extrudés depuis leur contour IGN : un mur par arête, dont
les coordonnées de texture suivent la longueur réelle, et un toit triangulé par
[earcut](https://github.com/mapbox/earcut), qui respecte les cours intérieures.

### Les ruines

Un bâtiment effondré ou éventré n'est plus un bloc écrêté mais une ruine
construite à partir de son contour (`world/render.ts`, `world/facade.ts`) :

- **un tas de gravats**, champ de hauteurs qui déborde sur la rue quand le
  bâtiment s'est effondré, plus bas au pied des murs quand il est éventré ;
- **des murs cassés par tronçons** de 2 à 6 m, chacun à sa hauteur, avec des
  brèches, et des angles qui tiennent mieux que le reste. Leur face extérieure
  garde la façade du bâtiment, sans vitres et couverte de poussière ; leur face
  intérieure montre les étages ;
- **les murs mitoyens** des voisins restés debout, mis à nu jusqu'à leur toit,
  en pignon quand il est en pente : la maçonnerie, les enduits des pièces
  disparues par plaques, la tranche des planchers arrachés, un conduit de
  cheminée noirci.

Les gravats sont un motif de Voronoi en mètres : des blocs de 1,1 m dont la
moitié ont éclaté en éclats de 35 cm, chacun posé de travers — éclairé ou dans
l'ombre, plus clair d'un côté —, séparés par des fentes d'ombre, sous une
poussière qui éteint leurs couleurs. Des cellules plates de couleurs franches
faisaient un carrelage.

Dans la ville photoréaliste, le relevé de Google est effacé sous chaque ruine
par la carte des ruines (voir l'en-tête de `world/photoreal.ts`), avec trois
subtilités apprises à l'écran :

- **Les voisins debout** gardent une marge : 60 cm côté ruine, 1,5 m sur rue,
  où le relevé déborde souvent du contour IGN. Au-dessus de leur toit, ou de
  leur gouttière dans l'emprise de la ruine, tout est effacé : c'était le toit
  de la ruine, qui restait en lambeaux au-dessus du mur mitoyen. Leur hauteur
  est celle du bâtiment entier, quel que soit son état : réduite comme dans la
  ville dessinée, elle rognait le toit des bâtiments incendiés.
- **La poussière** recouvre le relevé autour des ruines, surtout ce qui regarde
  le ciel, et d'autant plus ce qui est sombre et bleuté : la photographie garde
  les ombres des bâtiments effacés, qui restaient au sol comme des taches bleu
  nuit.
- **Une nappe sous la ville**, deux mètres sous le relief : le relevé n'est
  qu'une peau, et par le moindre jour au bord d'une découpe, on voyait le ciel.

### Trois contraintes de Cesium à connaître

1. **Les shaders sont en GLSL ES 3.00**, comme ceux de Cesium : `in`, `out`,
   `out_FragColor`. Écrire `attribute` ou `varying` échoue à la compilation.

2. **Un attribut par instance au nom inédit est refusé.** Les attributs par
   instance passent par la table de lots de Cesium, qui ne connaît qu'une liste
   fermée de noms (`color`, `show`...). Les dimensions voyagent donc dans un
   attribut **de géométrie**, qui accepte n'importe quel nom. Seule la couleur
   reste modifiable à chaud, d'où l'usage de son canal alpha comme interrupteur
   entre texture, façade de ruine, façade incendiée et aplat.

3. **Les coordonnées de texture restent entre 0 et 1.** Cesium les compresse
   en supposant cette plage : en mètres, elles faisaient des triangles clairs
   et sombres en dents de scie sur les murs des ruines. Elles sont donc
   normalisées, et les dimensions en mètres voyagent dans l'attribut `surf`.
   Dans le shader du relevé, par ailleurs, les couleurs du matériau sont
   linéaires : une teinte choisie à l'écran y ressort deux fois trop claire.

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
