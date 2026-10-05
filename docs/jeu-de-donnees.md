# Jeu de données

La touche `J` exporte un jeu de données d'images verticales annotées, pour
entraîner ou évaluer un détecteur de dégâts. Le drone balaie seul toute la zone,
pour chacun des quatre aléas, et chaque image part avec l'état exact de chaque
bâtiment qu'elle montre.

`Maj+J` exporte une [campagne variée](#la-campagne-variée-majj) : seize
scénarios au lieu de quatre, des images centrées sur les dégâts, à hauteur et
cap tirés au hasard.

## Lancer un export

1. Ouvrir le simulateur dans Chrome ou Edge : l'export écrit directement dans un
   dossier de l'ordinateur, ce que seuls ces navigateurs permettent.
2. Appuyer sur `J` (ou `Maj+J`), puis choisir un dossier. Un sous-dossier
   `drone-recon-<date>-<heure>` (ou `drone-recon-varie-…`) y est créé.
3. Laisser la fenêtre visible : le navigateur suspend les pages masquées. La
   progression s'affiche au-dessus des raccourcis, en bas de l'écran. Un nouvel appui sur `J`
   arrête l'export ; les images déjà prises sont conservées, avec leurs
   annotations.

Avec les réglages par défaut, la zone compte 261 cases occupées par au moins un
bâtiment, soit **1 044 images** pour les quatre aléas, en un quart d'heure environ sur
une GTX 1650 de portable. À la fin, la ville redevient intacte et le drone revient là où il
était.

## Ce que fait le balayage

Pour chaque aléa, joué avec ses réglages par défaut depuis la ville intacte
jusqu'à son état final, le drone survole un quadrillage à 60 m du sol, nord en
haut. Une image couvre alors 56 m de côté, soit 8,7 cm par pixel en
640 × 640 px. Les cases ne se recouvrent pas, et une case sans bâtiment n'est
pas photographiée.

Avant chaque prise, la vue verticale est rendue jusqu'à ce que le sol soit
chargé et que les ruines soient construites (`renderer.idle`), trois images de
suite, sans dépasser huit secondes.

## La campagne variée (Maj+J)

Le premier détecteur, entraîné sur le quadrillage, a trois faiblesses mesurées
(voir [détecteur entraîné](detecteur-entraine.md)) : il ne trouve qu'un
effondrement sur trois, il n'a vu qu'une hauteur de vol, et un seul cap. Le
quadrillage en est la cause : quatre sinistres seulement, toujours les mêmes, et
un bâtiment sur quatorze endommagé.

La campagne variée y répond.

- **Seize scénarios** (`dataset/variants.ts`) : chaque aléa est joué quatre
  fois, avec d'autres foyers répartis dans la ville, d'autres intensités et
  d'autres tirages. Le premier de chaque série reste le scénario par défaut.
- **Des images centrées sur les dégâts.** Une fois le sinistre joué, la plupart
  des images visent un bâtiment endommagé tiré au hasard, les effondrés trois
  fois plus souvent que les partiels ; un quart environ survolent le bâti pris
  au hasard, pour que le modèle voie aussi des toits intacts.
- **Hauteur et cap au hasard** : entre 40 et 90 m, dans toutes les directions,
  avec un décalage de la cible dans le cadre.

Le tirage dépend d'une graine : deux exports donnent les mêmes images.

| Mesure, GTX 1650 de portable | Valeur                            |
| ---------------------------- | --------------------------------- |
| Images                       | 2 202, dont 40 à 149 par scénario |
| Bâtiments annotés            | 39 514                            |
| Durée                        | 42 minutes                        |

Une inondation peu profonde endommage peu de bâtiments : ses scénarios ont
moins d'images, car on ne photographie pas cent fois le même toit.

**Les images se recouvrent.** Pour séparer entraînement et validation, il faut
les regrouper par zone géographique, jamais au hasard : sinon le modèle serait
validé sur des rues qu'il a déjà vues. `ml/preparer.py` le fait par zones de
250 m.

## Les fichiers

| Fichier            | Contenu                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------- |
| `images/`          | les images JPEG, nommées par scénario : `seisme_0001.jpg`, `seisme-2_0001.jpg`…         |
| `labels/`          | une étiquette YOLO par image : classe, centre et taille, entre 0 et 1                   |
| `data.yaml`        | la configuration YOLO ; aucune séparation entraînement / validation                     |
| `annotations.json` | les mêmes annotations au format COCO, avec le contour du toit                           |
| `metadonnees.csv`  | scénario et ses réglages, position, hauteur, cap, emprise et résolution de chaque image |
| `LISEZMOI.md`      | la notice du jeu, avec ses chiffres, ses limites et la source à citer                   |

Dans le fichier COCO, chaque annotation garde l'identifiant du bâtiment dans la
BD TOPO®, sa sévérité de 0 à 1 et la part restée dans le cadre.

## Les classes

| Rang YOLO | Classe      | État                 |
| --------- | ----------- | -------------------- |
| 0         | `intact`    | intact               |
| 1         | `cracked`   | fissuré              |
| 2         | `partial`   | effondrement partiel |
| 3         | `collapsed` | effondré             |
| 4         | `burnt`     | incendié             |

## Comment les annotations sont calculées

Elles viennent de la vérité du simulateur, sans le bruit du détecteur simulé
(`dataset/annotate.ts`). Le contour du toit est projeté à la hauteur qui reste
au bâtiment : quelques mètres pour une ruine. La boîte englobe le toit et le
pied, car loin du centre de l'image la perspective montre une façade. Un
bâtiment coupé par le bord n'est annoté que s'il en reste au moins 30 % dans le
cadre.

## Pourquoi la ville de l'IGN

Pendant l'export, le relevé photoréaliste de Google est masqué : les images
montrent la ville dessinée d'après l'IGN. Les conditions de Google Maps Platform
interdisent d'extraire ses images hors du service, ce que serait un jeu
d'entraînement. Les données de l'IGN sont sous Licence Ouverte Etalab 2.0 : la
réutilisation est libre, à condition de citer la source.

## Limites

- **Ce sont des images de synthèse.** Un modèle entraîné ici devra être validé
  sur de vraies images de drone.
- **La classe `cracked` a une signature discrète** : tuiles déplacées et
  quelques trous sur les toits, fissures fines sur les façades, qu'une vue
  verticale ne montre presque pas. Les jeux produits avant ces dessins la
  rendaient comme `intact`, avec laquelle on peut la fusionner.
- **Fumée, flammes et eau sont masquées** pendant la prise de vue.
- **Les occultations entre bâtiments sont ignorées**, et la photographie
  aérienne laisse parfois voir, autour d'une ruine, le toit d'origine.

## Réglages

Dans `CONFIG.dataset` (`core/config.ts`) : la hauteur du balayage, la taille et
la qualité des images, et la part minimale d'un bâtiment dans le cadre. La
section `varied` règle la campagne variée : hauteurs extrêmes, nombre d'images
par scénario, poids de chaque état dans le tirage des cibles.
