"""Entraîne un premier détecteur de dégâts sur le jeu préparé par preparer.py.

Le modèle de départ est YOLO nano, le plus léger, préentraîné sur COCO : il
tient dans les 4 Go d'une GTX 1650 et tournera ensuite dans un navigateur.

Deux réglages viennent de la machine :
- `amp=False` : la demi-précision donne des pertes NaN sur les GTX 16xx, une
  anomalie connue de cette génération ; on entraîne donc en précision simple ;
- `workers=2` : sous Windows, chaque processus de chargement recopie tout
  l'environnement Python ; deux suffisent à nourrir une petite carte.

Usage : python entrainer.py <data.yaml> [époques] [nom] [--lot N]
        le nom désigne le dossier sous runs/ (par défaut « detecteur ») :
        un nouvel entraînement n'écrase pas le précédent.
        --lot : images par lot (16 par défaut). Le calcul de la perte grossit
        avec le nombre de bâtiments par image : sur un jeu dense, comme la
        campagne variée, 16 dépassent les 4 Go d'une GTX 1650, et le surplus
        déborde dans la mémoire vive : plus de dix fois plus lent. Ultralytics accumule
        les gradients jusqu'à 64 images : changer le lot ne change pas le pas
        d'apprentissage effectif.
"""

import sys
from pathlib import Path

from ultralytics import YOLO

MODEL = "yolo11n.pt"
RUNS = Path(__file__).resolve().parent / "runs"


def main() -> None:
    args = sys.argv[1:]
    batch = 16
    if "--lot" in args:
        i = args.index("--lot")
        batch = int(args[i + 1])
        del args[i : i + 2]
    data = Path(args[0]).resolve()
    epochs = int(args[1]) if len(args) > 1 else 60
    name = args[2] if len(args) > 2 else "detecteur"

    model = YOLO(MODEL)
    model.train(
        data=str(data),
        epochs=epochs,
        imgsz=640,
        batch=batch,
        device=0,
        workers=2,
        amp=False,
        # Les images sont prises à la verticale : le retournement haut-bas est
        # aussi plausible que le gauche-droite.
        flipud=0.5,
        fliplr=0.5,
        project=str(RUNS),
        name=name,
        exist_ok=True,
        seed=7301,
        plots=True,
    )
    # Sans `project`, Ultralytics écrirait dans runs/ sous le dossier courant.
    metrics = model.val(data=str(data), split="val", plots=True, project=str(RUNS), name=f"{name}-validation", exist_ok=True)
    print(f"mAP50 {metrics.box.map50:.3f} · mAP50-95 {metrics.box.map:.3f}")
    print(f"meilleurs poids : {RUNS / name / 'weights' / 'best.pt'}")


if __name__ == "__main__":
    main()
