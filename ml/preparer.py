"""Prépare un export du simulateur (touche J) pour l'entraînement YOLO.

Deux choix, justifiés :

1. Séparation par EMPLACEMENT, pas par image. Un même numéro de case
   (`seisme_0042`, `explosion_0042`…) montre le même endroit pour les quatre
   aléas : mélanger ces images entre entraînement et validation ferait
   valider le modèle sur des rues qu'il a déjà vues. Une case sur cinq,
   choisie par une graine fixe, part en validation avec ses quatre aléas.

2. La classe « fissuré » est fusionnée avec « intact ». Dans la ville dessinée,
   un bâtiment fissuré est rendu exactement comme un bâtiment intact (voir
   docs/jeu-de-donnees.md) : demander au modèle de les distinguer, ce serait
   lui apprendre à deviner.

Usage : python preparer.py <dossier de l'export> [dossier de sortie]
"""

import random
import shutil
import sys
from pathlib import Path

# Classes de l'export (DAMAGE_ORDER) -> classes d'entraînement.
CLASSES = ["intact", "partial", "collapsed", "burnt"]
REMAP = {0: 0, 1: 0, 2: 1, 3: 2, 4: 3}  # fissuré (1) -> intact (0)
VALIDATION = 0.2
SEED = 7301


def main() -> None:
    source = Path(sys.argv[1]).resolve()
    target = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else source.with_name(source.name + "-yolo")
    images = sorted((source / "images").glob("*.jpg"))
    if not images:
        sys.exit(f"Aucune image dans {source / 'images'}")

    cells = sorted({p.stem.rsplit("_", 1)[1] for p in images})
    # Tirage à graine fixe, pour que la séparation soit reproductible : il ne
    # protège rien, un générateur cryptographique n'aurait pas de sens ici.
    rng = random.Random(SEED)
    val_cells = set(rng.sample(cells, round(len(cells) * VALIDATION)))  # NOSONAR

    if target.exists():
        shutil.rmtree(target)
    counts = {split: [0] * len(CLASSES) for split in ("train", "val")}
    for image in images:
        split = "val" if image.stem.rsplit("_", 1)[1] in val_cells else "train"
        (target / "images" / split).mkdir(parents=True, exist_ok=True)
        (target / "labels" / split).mkdir(parents=True, exist_ok=True)
        shutil.copy2(image, target / "images" / split / image.name)

        lines = []
        label = source / "labels" / f"{image.stem}.txt"
        for line in label.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            cls, *box = line.split()
            new = REMAP[int(cls)]
            counts[split][new] += 1
            lines.append(" ".join([str(new), *box]))
        (target / "labels" / split / label.name).write_text("\n".join(lines), encoding="utf-8")

    names = "\n".join(f"  {i}: {name}" for i, name in enumerate(CLASSES))
    (target / "data.yaml").write_text(
        f"# Préparé par ml/preparer.py depuis {source.name}\n"
        f"path: {target.as_posix()}\n"
        "train: images/train\n"
        "val: images/val\n"
        f"names:\n{names}\n",
        encoding="utf-8",
    )

    n_train = len(list((target / "images" / "train").glob("*.jpg")))
    n_val = len(list((target / "images" / "val").glob("*.jpg")))
    print(f"{len(cells)} emplacements, dont {len(val_cells)} en validation")
    print(f"images : {n_train} entraînement, {n_val} validation")
    for split in ("train", "val"):
        detail = ", ".join(f"{CLASSES[i]} {n}" for i, n in enumerate(counts[split]))
        print(f"bâtiments ({split}) : {detail}")
    print(f"prêt : {target / 'data.yaml'}")


if __name__ == "__main__":
    main()
