# Pilotage gestuel

Le drone se pilote aux deux mains devant une webcam, grâce au suivi de mains
MediaPipe exécuté localement dans le navigateur. Aucune image ne quitte la
machine.

La touche `H` active ou coupe le pilotage gestuel ; `K` relance le calibrage.

## Disposition des commandes

Disposition **Mode 2**, celle des radiocommandes de drone :

| Main   | Mouvement vertical | Mouvement horizontal |
| ------ | ------------------ | -------------------- |
| Gauche | altitude           | rotation (lacet)     |
| Droite | avancer / reculer  | translation latérale |

| Geste                              | Effet                                     |
| ---------------------------------- | ----------------------------------------- |
| Pincement pouce-index, main droite | prendre une photo nadir                   |
| Pincement pouce-index, main gauche | basculer la vue diagnostique              |
| Deux poings fermés                 | stabilisation : le drone fige sa position |
| Une main hors champ                | ses deux axes retombent à zéro            |

Au démarrage, garder les deux mains **ouvertes, au centre et immobiles** pendant
les trois secondes de calibrage : leur position de repos devient le neutre des
manches.

## Pourquoi deux mains plutôt qu'une

C'était une question ouverte du cahier des charges. La réponse tient à la
géométrie du problème.

Un multirotor a quatre axes continus. Une main n'en pilote proprement que deux —
sa position horizontale et verticale dans l'image. Pour obtenir les deux autres,
il faudrait exploiter la profondeur estimée par MediaPipe, qui est bruitée, et
l'angle du poignet, qui déplace aussi la paume et contamine donc les axes déjà
utilisés. S'y ajoute un conflit de fond : les gestes ponctuels, comme le
pincement pour la photo, se font avec les doigts qui tiennent le vol.

Deux mains répartissent la charge sur deux axes chacune, libèrent les doigts pour
les gestes, et offrent une sécurité lisible : une main qui disparaît n'annule que
ses propres axes, le drone reste en stationnaire sur ceux-là.

Un mode dégradé à une main reste possible en modifiant la correspondance dans
`src/input/hands.ts`.

## Du geste à la commande

Chaque main passe par trois étapes :

1. **Centre de paume** — moyenne de cinq points de la main, bien plus stable qu'un
   doigt isolé.
2. **Lissage One Euro** — voir ci-dessous.
3. **Zone morte puis renormalisation** — une petite zone centrale ne produit
   aucune commande, sans quoi le drone dériverait en permanence. La commande est
   ensuite renormalisée : sans cette étape, elle sauterait brutalement de zéro à
   la valeur du seuil en sortant de la zone morte.

Le pincement utilise une hystérésis — un seuil pour s'enclencher, un autre plus
large pour se relâcher — et un anti-rebond, pour qu'un pincement tenu ne
déclenche pas une rafale de photos.

## Réactivité : le réglage qui compte

MediaPipe tremble en permanence, même main immobile. Un lissage à coefficient
fixe forcerait à choisir entre « ça tremble » et « ça traîne ». Le filtre One
Euro résout ce compromis : il lisse fort quand le mouvement est lent, c'est-à-dire
quand le tremblement se voit, et s'ouvre quand le mouvement est rapide, quand
c'est la latence qui se voit.

```
coupure = minCutoff + beta × vitesse
```

Les coordonnées de MediaPipe étant normalisées entre 0 et 1, un geste franc vaut
1 à 3 unités par seconde. Avec un `beta` trop faible, le second terme devient
négligeable, le filtre ne s'ouvre jamais, et il se comporte comme un simple
passe-bas. C'était le cas de la première version, jugée « un peu lente » à
l'usage.

Latence pour atteindre 90 % de la consigne, sur un geste de 0,30 unité en
0,30 s, échantillonné à 30 Hz :

| minCutoff | beta     | Latence   | Tremblement au repos |
| --------- | -------- | --------- | -------------------- |
| 1,2       | 0,01     | 200 ms    | référence            |
| **1,6**   | **0,70** | **67 ms** | inchangé             |
| 3,2       | 1,50     | 33 ms     | visible              |

C'est `beta` qu'il faut régler en premier : il ne coûte rien au repos et
n'accélère que les gestes francs. Monter `minCutoff` réduit aussi la latence,
mais laisse passer le tremblement.

## Réglages

Dans `src/core/config.ts`, section `hands` :

| Clé                   | Défaut  | Effet                                            |
| --------------------- | ------- | ------------------------------------------------ |
| `smoothing.beta`      | 0,70    | réactivité aux gestes rapides                    |
| `smoothing.minCutoff` | 1,6     | lissage au repos                                 |
| `deadzone`            | 0,12    | zone morte centrale, en fraction du cadre        |
| `gain`                | 0,30    | amplitude utile autour du centre                 |
| `calibrationTime`     | 3 s     | durée du calibrage initial                       |
| `swapHands`           | `false` | à activer si gauche et droite semblent inversées |

## Conditions d'usage

Le suivi dépend de l'éclairage et de la webcam. Il fonctionne mieux avec une
lumière de face, un fond peu chargé, et les deux mains entièrement dans le cadre
— une main coupée par le bord de l'image perd ses repères et ses axes. Le
panneau « Pilotage », en bas à gauche, montre le retour caméra et la position des
deux manches virtuels : c'est le premier endroit où regarder si le drone réagit
mal.
