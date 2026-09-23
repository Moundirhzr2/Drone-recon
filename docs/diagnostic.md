# Diagnostic des dommages

![Vue diagnostique : effondrés en rouge, partiels en orange, fissurés en jaune](images/02-diagnostic.jpg)

## Vue brute et vue diagnostique

La touche `V` bascule entre deux lectures de la même scène.

En **vue brute**, la ville est montrée telle qu'elle est. Le sinistre se lit dans
la géométrie : hauteur écrêtée, gravats au sol, toitures manquantes.

En **vue diagnostique**, la classification est superposée : boîtes colorées,
étiquettes, scores de confiance, et un rapport trié par gravité. Les façades
repassent en aplat pour que la couleur de classification ne soit pas brouillée
par la trame des fenêtres.

C'est toute la différence entre constater et interpréter. Les bâtiments intacts
restent volontairement neutres : les peindre en vert noierait les quelques cibles
qui comptent sous des dizaines d'aplats. Une vue de diagnostic doit faire
ressortir l'anomalie, pas la normalité.

| Classe               | Code   | Couleur |
| -------------------- | ------ | ------- |
| Fissuré              | `FISS` | jaune   |
| Effondrement partiel | `PART` | orange  |
| Effondré             | `EFFO` | rouge   |
| Incendié             | `FEU`  | violet  |

## Ce que fait réellement le détecteur

`src/diagnostic/detector.ts` **ne fait pas de vision par ordinateur.** Il lit la
vérité terrain de la simulation et la restitue au format exact d'un détecteur
d'objets : une boîte, une classe, un score de confiance.

C'est un choix, pas un raccourci, et il a trois avantages concrets :

1. **La sortie a le format d'un vrai détecteur.** Brancher un modèle YOLO exporté
   en ONNX sur l'image nadir revient à remplacer la fonction `analyse()` ; rien en
   aval ne change.
2. **Le bruit est réaliste.** La confiance baisse avec la distance et la taille
   apparente de la cible, les classes voisines se confondent quand la confiance
   est moyenne, et des faux positifs apparaissent — ombre portée, toiture sombre.
   Descendre pour confirmer une cible a donc un sens en vol.
3. **Les métriques s'affichent en direct.** Comme la vérité terrain est connue,
   la précision et le rappel sont calculés à chaque prise de vue — ce qu'aucun
   détecteur réel ne peut faire sur le terrain, faute de connaître la réponse.

Le bruit est déterministe par bâtiment : sans cela, les boîtes clignoteraient
d'une image à l'autre et l'affichage serait illisible.

Mesuré sur un même foyer de dégâts, le rappel passe de 11 % à 250 m d'altitude à
85 % à 150 m, puis 100 % à 60 m. La mécanique de jeu fonctionne : il faut
s'approcher pour voir.

## Lire les métriques

| Métrique      | Question à laquelle elle répond                                   |
| ------------- | ----------------------------------------------------------------- |
| **Précision** | Parmi les alertes levées, quelle part est justifiée ?             |
| **Rappel**    | Parmi les dégâts réels dans le cadre, quelle part a été repérée ? |
| **Classe OK** | Parmi les dégâts repérés, quelle part a reçu la bonne classe ?    |
| **Manqués**   | Combien de dégâts réels sont passés inaperçus ?                   |

Une métrique affiche un tiret quand elle n'est pas définie — aucune alerte à
juger, aucun dégât dans le cadre. La distinction compte : afficher « 100 % » sur
un cadre vide laisserait croire à une performance parfaite alors qu'il n'y a rien
à évaluer.

## Réglages

Dans `src/core/config.ts`, section `detector` :

| Clé                 | Défaut | Effet                                                                |
| ------------------- | ------ | -------------------------------------------------------------------- |
| `threshold`         | 0,45   | confiance minimale pour retenir une détection                        |
| `noise`             | 0,11   | écart-type du bruit sur le score ; plus haut, détecteur moins fiable |
| `falsePositiveRate` | 0,05   | probabilité qu'un bâtiment intact soit signalé à tort                |
| `range`             | 260 m  | portée de détection depuis le drone                                  |

## Fonds de scène

Par défaut, le simulateur n'a besoin d'aucune clé. Pour changer de fond, copier
`.env.example` en `.env` :

| `VITE_WORLD_BACKEND` | Rendu                                            | Clé requise                                                |
| -------------------- | ------------------------------------------------ | ---------------------------------------------------------- |
| `offline` _(défaut)_ | ville réelle de l'IGN sur photographie aérienne  | aucune                                                     |
| `ion`                | terrain mondial et bâtiments OpenStreetMap en 3D | token [Cesium ion](https://ion.cesium.com/tokens), gratuit |
| `google`             | tuiles photoréalistes                            | clé Google Map Tiles API, **facturée à l'usage**           |

**Le mode `google` ne remplace pas les bâtiments de l'IGN.** Son maillage
photogrammétrique est un seul bloc de géométrie : aucun bâtiment n'y est
sélectionnable individuellement, donc aucun ne peut être coloré ni effondré. Les
bâtiments de l'IGN restent posés par-dessus ; ce sont eux qui portent les
dommages, le photoréalisme n'est que le décor.

Le mode `offline` pose la photographie aérienne de l'IGN (BD ORTHO®) sur la
région, et l'imagerie mondiale Esri World Imagery au-delà (crédit : Esri, Maxar,
Earthstar Geographics), avec OpenStreetMap en repli si la source est injoignable.
L'imagerie Esri convient à un usage personnel ; un déploiement public
demanderait une source sous contrat.

Le choix d'un sol photographique n'est pas cosmétique. Avec une carte routière,
le drone survolerait un plan — rues nommées, bâtiments déjà dessinés en 2D sous
les volumes 3D. La photographie aérienne donne un sol sur lequel les bâtiments
viennent se poser — et comme ce sont les vrais, leurs contours tombent sur leurs
propres toits : le rendu fil de fer le montre.
