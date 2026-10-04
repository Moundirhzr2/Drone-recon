"""Prépare un export du simulateur (touche J ou Maj+J) pour l'entraînement YOLO.

Deux choix, justifiés :

1. Séparation par EMPLACEMENT, jamais par image : valider le modèle sur des
   rues qu'il a déjà vues gonflerait ses scores.

   - Par défaut, par ZONES de 250 m. Les images de la campagne variée se
     recouvrent et n'ont pas de case : on découpe la ville en carrés, et une
     zone sur cinq part en validation. Les zones sont rangées de la plus
     touchée à la moins touchée et prises à intervalle régulier, pour que la
     validation ait sa part de dégâts. Une image va en validation si son
     centre est dans une zone de validation ; en entraînement si son emprise
     ne touche aucune de ces zones ; les autres, à cheval, sont écartées.
   - Avec `--par-case`, la méthode de la première version, pour la grille :
     un même numéro de case (`seisme_0042`, `explosion_0042`…) montre le même
     endroit pour les quatre aléas, et une case sur cinq, choisie par une
     graine fixe, part en validation avec ses quatre images.

2. La classe « fissuré » est fusionnée avec « intact ». Dans la ville dessinée,
   un bâtiment fissuré est rendu exactement comme un bâtiment intact (voir
   docs/jeu-de-donnees.md) : demander au modèle de les distinguer, ce serait
   lui apprendre à deviner.

Usage : python preparer.py <dossier de l'export> [dossier de sortie] [--par-case]
"""

import csv
import math
import random
import shutil
import sys
from pathlib import Path

# Classes de l'export (DAMAGE_ORDER) -> classes d'entraînement.
CLASSES = ["intact", "partial", "collapsed", "burnt"]
REMAP = {0: 0, 1: 0, 2: 1, 3: 2, 4: 3}  # fissuré (1) -> intact (0)
VALIDATION = 0.2
SEED = 7301
# Côté d'une zone, en mètres : bien plus grand que l'emprise d'une image (84 m
# au plus), pour que peu d'images soient à cheval sur deux zones.
ZONE = 250
# Classes de l'export qui sont des dégâts visibles : partiel, effondré, incendié.
DAMAGE = {2, 3, 4}


def split_by_cell(images: list[Path]) -> dict[str, str]:
    """Méthode de la première version : une case sur cinq en validation."""
    cells = sorted({p.stem.rsplit("_", 1)[1] for p in images})
    # Tirage à graine fixe, pour que la séparation soit reproductible : il ne
    # protège rien, un générateur cryptographique n'aurait pas de sens ici.
    rng = random.Random(SEED)
    val_cells = set(rng.sample(cells, round(len(cells) * VALIDATION)))  # NOSONAR
    return {p.name: "val" if p.stem.rsplit("_", 1)[1] in val_cells else "train" for p in images}


def split_by_zone(source: Path, images: list[Path]) -> dict[str, str]:
    """Une zone de 250 m sur cinq en validation ; les images à cheval sont écartées."""
    with (source / "metadonnees.csv").open(encoding="utf-8") as f:
        meta = {row["image"]: row for row in csv.DictReader(f)}
    lat0 = sum(float(r["latitude"]) for r in meta.values()) / len(meta)
    lon0 = sum(float(r["longitude"]) for r in meta.values()) / len(meta)
    m_lon = 111320 * math.cos(math.radians(lat0))

    def position(name: str) -> tuple[float, float, float]:
        r = meta[name]
        east = (float(r["longitude"]) - lon0) * m_lon
        north = (float(r["latitude"]) - lat0) * 111320
        return east, north, float(r["emprise_m"])

    def zone(east: float, north: float) -> tuple[int, int]:
        return math.floor(east / ZONE), math.floor(north / ZONE)

    # Dégâts visibles par zone, comptés sur les images qui y sont centrées.
    damage: dict[tuple[int, int], int] = {}
    for image in images:
        east, north, _ = position(image.name)
        label = source / "labels" / f"{image.stem}.txt"
        hits = sum(1 for line in label.read_text(encoding="utf-8").splitlines() if line.strip() and int(line.split()[0]) in DAMAGE)
        damage[zone(east, north)] = damage.get(zone(east, north), 0) + hits

    # Rangées de la plus touchée à la moins touchée, une sur cinq.
    ranked = sorted(damage, key=lambda z: (-damage[z], z))
    step = round(1 / VALIDATION)
    val_zones = set(ranked[step // 2 :: step])

    split = {}
    for image in images:
        east, north, footprint = position(image.name)
        # L'image tourne avec le cap : son emprise tient dans un carré de côté
        # footprint·√2, dont on teste les quatre coins (plus petit qu'une zone,
        # il ne peut toucher que les zones de ses coins).
        half = footprint * math.sqrt(2) / 2
        corners = {zone(east + dx, north + dy) for dx in (-half, half) for dy in (-half, half)}
        if zone(east, north) in val_zones:
            split[image.name] = "val"
        elif corners & val_zones:
            split[image.name] = "ecartee"
        else:
            split[image.name] = "train"
    print(f"{len(ranked)} zones de {ZONE} m, dont {len(val_zones)} en validation")
    return split


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    by_cell = "--par-case" in sys.argv
    source = Path(args[0]).resolve()
    target = Path(args[1]).resolve() if len(args) > 1 else source.with_name(source.name + "-yolo")
    images = sorted((source / "images").glob("*.jpg"))
    if not images:
        sys.exit(f"Aucune image dans {source / 'images'}")

    split = split_by_cell(images) if by_cell else split_by_zone(source, images)

    if target.exists():
        shutil.rmtree(target)
    counts = {s: [0] * len(CLASSES) for s in ("train", "val")}
    kept = {s: 0 for s in ("train", "val", "ecartee")}
    for image in images:
        part = split[image.name]
        kept[part] += 1
        if part == "ecartee":
            continue
        (target / "images" / part).mkdir(parents=True, exist_ok=True)
        (target / "labels" / part).mkdir(parents=True, exist_ok=True)
        shutil.copy2(image, target / "images" / part / image.name)

        lines = []
        label = source / "labels" / f"{image.stem}.txt"
        for line in label.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            cls, *box = line.split()
            new = REMAP[int(cls)]
            counts[part][new] += 1
            lines.append(" ".join([str(new), *box]))
        (target / "labels" / part / label.name).write_text("\n".join(lines), encoding="utf-8")

    # Les métadonnées suivent, avec la part de chaque image : evaluer.py s'en
    # sert pour détailler les scores par hauteur de vol.
    metadata = source / "metadonnees.csv"
    if metadata.exists():
        with metadata.open(encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        with (target / "metadonnees.csv").open("w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=[*rows[0].keys(), "part"], lineterminator="\n")
            writer.writeheader()
            for row in rows:
                if split.get(row["image"], "ecartee") != "ecartee":
                    writer.writerow({**row, "part": split[row["image"]]})

    names = "\n".join(f"  {i}: {name}" for i, name in enumerate(CLASSES))
    (target / "data.yaml").write_text(
        f"# Préparé par ml/preparer.py depuis {source.name}"
        f" ({'par case' if by_cell else f'par zones de {ZONE} m'})\n"
        f"path: {target.as_posix()}\n"
        "train: images/train\n"
        "val: images/val\n"
        f"names:\n{names}\n",
        encoding="utf-8",
        newline="\n",
    )

    print(f"images : {kept['train']} entraînement, {kept['val']} validation, {kept['ecartee']} écartées")
    for part in ("train", "val"):
        detail = ", ".join(f"{CLASSES[i]} {n}" for i, n in enumerate(counts[part]))
        print(f"bâtiments ({part}) : {detail}")
    print(f"prêt : {target / 'data.yaml'}")


if __name__ == "__main__":
    main()
