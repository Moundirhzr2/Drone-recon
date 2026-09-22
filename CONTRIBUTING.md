# Contribuer

Merci de l'intérêt porté au projet. Ce document rassemble ce qu'il faut savoir
avant de proposer une modification.

## Mettre en place l'environnement

```bash
git clone https://github.com/Moundirhzr2/drone-recon.git
cd drone-recon
npm install
npm run dev
```

Node.js 20 ou plus récent est requis.

## Avant de proposer une modification

```bash
npm run verify
```

Cette commande enchaîne la vérification du formatage, le lint, le contrôle des
types et la construction de production. C'est exactement ce que lance
l'intégration continue : si elle passe en local, elle passera sur la
proposition.

## Conventions

**Langue.** Le code, les commentaires et la documentation sont en français. Les
identifiants de code restent en anglais quand ils nomment un concept technique
standard (`timeline`, `fragility`, `overlay`).

**Commentaires.** Un commentaire explique _pourquoi_, rarement _quoi_ : le code dit
déjà ce qu'il fait. Les décisions non évidentes — un contournement de Cesium, un
calage physique, un compromis de performance — sont justifiées sur place, avec la
mesure qui les appuie quand il y en a une.

**Mesurer avant d'affirmer.** Une optimisation s'accompagne de sa mesure avant et
après ; un calage physique, de la référence contre laquelle il a été vérifié. Les
documents de `docs/` suivent la même règle.

**Réglages.** Toute valeur ajustable par un utilisateur va dans
`src/core/config.ts`, commentée, plutôt qu'en dur dans un module.

**Messages de commit.** Format [Conventional Commits](https://www.conventionalcommits.org/fr/) :

```
feat(simulateur): ajouter le glissement de terrain
fix(camera): corriger l'axe de recul de la vue de suivi
docs: détailler le calage de l'explosion
perf(rendu): regrouper les reconstructions du bâti
```

## Signaler un problème

Ouvrir une _issue_ en précisant :

- ce qui était attendu et ce qui s'est produit ;
- le navigateur et le moteur de rendu, affiché dans la console au démarrage
  (ligne `[gpu] moteur de rendu : …`) ;
- le nombre d'images par seconde affiché dans le HUD, s'il s'agit de performance.

La ligne du moteur de rendu tranche souvent la question : un nom contenant
`SwiftShader` ou `software` signifie que le navigateur calcule la 3D sans carte
graphique.
