# Données

La ville du simulateur n'est pas inventée : c'est le centre de Mulhouse, autour
de la place de la Réunion, reconstitué à partir de trois jeux de données publics
de l'[IGN](https://www.ign.fr), sous
[Licence Ouverte Etalab 2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence/).

| Donnée         | Produit IGN | Contenu                                                | Fichier                                 |
| -------------- | ----------- | ------------------------------------------------------ | --------------------------------------- |
| Bâtiments      | BD TOPO®    | 2 282 emprises, hauteurs, usages, matériaux, années    | `public/data/mulhouse-centre.json`      |
| Relief         | RGE ALTI®   | 121 × 121 altitudes au pas de 10 m, sur 1,2 km de côté | `public/data/mulhouse-relief.json`      |
| Photo aérienne | BD ORTHO®   | le sol vu du ciel, à 20 cm environ                     | chargée en ligne, service WMTS de l'IGN |

![Le centre de Mulhouse reconstitué depuis les données de l'IGN](images/01-survol.jpg)

## Pourquoi des fichiers figés

Les bâtiments et le relief sont téléchargés **une fois**, puis versionnés dans le
dépôt. Deux raisons :

- le simulateur démarre sans réseau ni clé d'API ;
- surtout, une simulation de désastre n'est comparable d'une fois sur l'autre
  que si la ville ne change pas sous nos pieds.

Pour les régénérer, depuis les services publics de la Géoplateforme :

```bash
npm run data            # bâtiments puis relief
npm run data:buildings  # BD TOPO® seule
npm run data:relief     # RGE ALTI® seul
```

Les scripts sont dans [`scripts/`](../scripts). Ils interrogent les services par
pages (bâtiments) ou par lots de cent points (relief), avec une courte pause
entre deux requêtes pour ne pas surcharger un service public gratuit.

## Des attributs bruts à la vulnérabilité

Les fichiers gardent les attributs **tels que l'IGN les publie**. Toute
interprétation se fait dans le simulateur (`world/realCity.ts`), où elle est
documentée et peut évoluer sans retélécharger.

**Emprises.** Les contours sont convertis en mètres locaux autour du centre de la
zone, arrondis au décimètre : bien en deçà de la précision annoncée par l'IGN,
et deux fois plus léger qu'en degrés. Les éclats de moins de 4 m², artefacts de
découpage, sont écartés. Chaque bâtiment est extrudé depuis son contour exact —
un mur par arête — et son toit est triangulé avec
[earcut](https://github.com/mapbox/earcut), ce qui respecte les cours
intérieures.

**Hauteur.** L'IGN publie la hauteur à la gouttière et l'altitude du faîte. Nos
toits sont plats : on les place à mi-chemin, ce qui conserve à peu près le volume
d'un toit à deux pans.

**Année de construction.** Elle n'est connue que pour 1 061 bâtiments sur 2 282
(46 %). Pour les autres, on prend la médiane des six voisins datés les plus
proches, dans un rayon de 80 m : les bâtiments d'un même îlot ont presque
toujours été construits à la même époque.

**Matériau des murs.** C'est l'attribut qui compte le plus pour un séisme, et
l'IGN le fournit. Il module la vulnérabilité dans l'ordre de l'échelle EMS-98 :

| Matériau  | Coefficient |
| --------- | ----------- |
| pierre    | × 1,15      |
| meulière  | × 1,12      |
| brique    | × 1,05      |
| aggloméré | × 1,00      |
| bois      | × 0,85      |
| béton     | × 0,78      |

L'usage (logement, commerce, culte, annexe…) et le caractère léger de la
construction entrent aussi en compte. Le calcul complet est dans
`computeVulnerability` (`world/buildings.ts`).

## Corrections

Une seule hauteur est corrigée à la main : la **tour de l'Europe**, à qui la
BD TOPO® attribue 53 m alors qu'elle culmine vers 100 m (112 m antenne comprise).
C'est la seule erreur flagrante relevée dans la zone, et elle touche le bâtiment
le plus reconnaissable de la ville.

Le **temple Saint-Étienne** garde sa hauteur IGN. Sa flèche de 97 m est trop
fine pour être obtenue en extrudant l'emprise de tout l'édifice : le temple
apparaît comme une nef, en grès rose des Vosges.

## Altitudes

Les altitudes de l'IGN sont mesurées au-dessus du niveau de la mer, pas
au-dessus de l'ellipsoïde WGS84 qu'emploie Cesium. L'écart est d'environ 49 m en
Alsace. Il est sans conséquence tant que le terrain, les bâtiments et le drone
partagent la même référence, ce qui est le cas en mode hors-ligne. Les modes
`ion` et `google` apportent leur propre terrain et n'utilisent pas ce relief.

## Dégâts de départ

La ville ne démarre pas intacte : deux zones sont déjà sinistrées, l'une
endommagée, l'autre incendiée, pour que la reconnaissance ait quelque chose à
trouver dès le décollage. Elles sont serrées — 90 et 110 m de rayon — parce que
la vieille ville est dense : un foyer plus large y toucherait des centaines de
bâtiments, et une reconnaissance n'aurait plus de sens.

## Attribution

À reproduire avec toute image ou donnée issue du simulateur :

> © IGN — BD TOPO®, RGE ALTI®, BD ORTHO® — Licence Ouverte Etalab 2.0

Hors de la France, le sol vient d'Esri World Imagery (Esri, Maxar, Earthstar
Geographics), qui convient à un usage personnel ; un déploiement public
demanderait une source sous contrat.
