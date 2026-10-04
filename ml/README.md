# Détecteur de dégâts

Entraînement d'un premier vrai détecteur sur le jeu de données que le simulateur
exporte (touche `J`, voir [jeu de données](../docs/jeu-de-donnees.md)).

## Installation

Dans un environnement isolé, pour ne pas toucher au Python du système :

```bash
python -m venv ml/.venv
ml/.venv/Scripts/python -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
ml/.venv/Scripts/python -m pip install -r ml/requirements.txt
```

PyTorch s'installe avec CUDA 12.8 : l'entraînement tourne sur la carte
graphique. Compter environ 6 Go sur le disque.

## Étapes

```bash
# 1. Séparer entraînement et validation, par emplacement
ml/.venv/Scripts/python ml/preparer.py ml/datasets/drone-recon-<date>

# 2. Entraîner YOLO nano, puis le mesurer sur la validation
ml/.venv/Scripts/python ml/entrainer.py ml/datasets/drone-recon-<date>-yolo/data.yaml
```

`preparer.py` met une case sur cinq en validation, avec ses quatre aléas : un
même numéro de case montre le même endroit, et le modèle ne doit pas être
validé sur des rues qu'il a déjà vues. Il fusionne aussi la classe « fissuré »
avec « intact », car la ville dessinée ne la distingue pas à l'image.

`entrainer.py` part de YOLO nano préentraîné, le plus léger : il tient dans les
4 Go d'une GTX 1650 et pourra tourner dans un navigateur. La demi-précision est
coupée (`amp=False`) : elle donne des pertes NaN sur les GTX 16xx.

Les poids, les courbes et la matrice de confusion vont dans `ml/runs/`, exclu
de Git, comme l'environnement et les jeux de données.
