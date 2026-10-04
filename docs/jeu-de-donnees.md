# Jeu de données

La touche `J` exporte un jeu de données d'images verticales annotées, pour
entraîner ou évaluer un détecteur de dégâts. Le drone balaie seul toute la zone,
pour chacun des quatre aléas, et chaque image part avec l'état exact de chaque
bâtiment qu'elle montre.

## Lancer un export

1. Ouvrir le simulateur dans Chrome ou Edge : l'export écrit directement dans un
   dossier de l'ordinateur, ce que seuls ces navigateurs permettent.
2. Appuyer sur `J`, puis choisir un dossier. Un sous-dossier
   `drone-recon-<date>-<heure>` y est créé.
3. Laisser la fenêtre visible : le navigateur suspend les pages masquées. La
   progression s'affiche dans le panneau de pilotage. Un nouvel appui sur `J`
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

## Les fichiers

| Fichier            | Contenu                                                               |
| ------------------ | --------------------------------------------------------------------- |
| `images/`          | les images JPEG, nommées par aléa : `seisme_0001.jpg`…                |
| `labels/`          | une étiquette YOLO par image : classe, centre et taille, entre 0 et 1 |
| `data.yaml`        | la configuration YOLO ; aucune séparation entraînement / validation   |
| `annotations.json` | les mêmes annotations au format COCO, avec le contour du toit         |
| `metadonnees.csv`  | position, hauteur, cap, emprise et résolution de chaque image         |
| `LISEZMOI.md`      | la notice du jeu, avec ses chiffres, ses limites et la source à citer |

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
- **La classe `cracked` n'a pas de signature visuelle** : la ville dessinée
  représente un bâtiment fissuré comme un bâtiment intact. On peut la fusionner
  avec `intact`, ou l'écarter.
- **Fumée, flammes et eau sont masquées** pendant la prise de vue.
- **Les occultations entre bâtiments sont ignorées**, et la photographie
  aérienne laisse parfois voir, autour d'une ruine, le toit d'origine.

## Réglages

Dans `CONFIG.dataset` (`core/config.ts`) : la hauteur du balayage, la taille et
la qualité des images, et la part minimale d'un bâtiment dans le cadre.
