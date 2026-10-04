"""Entraîne un premier détecteur de dégâts sur le jeu préparé par preparer.py.

Le modèle de départ est YOLO nano, le plus léger, préentraîné sur COCO : il
tient dans les 4 Go d'une GTX 1650 et tournera ensuite dans un navigateur.

Deux réglages viennent de la machine :
- `amp=False` : la demi-précision donne des pertes NaN sur les GTX 16xx, une
  anomalie connue de cette génération ; on entraîne donc en précision simple ;
- `workers=2` : sous Windows, chaque processus de chargement recopie tout
  l'environnement Python ; deux suffisent à nourrir une petite carte.

Usage : python entrainer.py <data.yaml> [époques]
"""

import sys
from pathlib import Path

from ultralytics import YOLO

MODEL = "yolo11n.pt"
RUNS = Path(__file__).resolve().parent / "runs"


def main() -> None:
    data = Path(sys.argv[1]).resolve()
    epochs = int(sys.argv[2]) if len(sys.argv) > 2 else 60

    model = YOLO(MODEL)
    model.train(
        data=str(data),
        epochs=epochs,
        imgsz=640,
        batch=16,
        device=0,
        workers=2,
        amp=False,
        # Les images sont prises nord en haut, à la verticale : le retournement
        # haut-bas est aussi plausible que le gauche-droite.
        flipud=0.5,
        fliplr=0.5,
        project=str(RUNS),
        name="detecteur",
        exist_ok=True,
        seed=7301,
        plots=True,
    )
    # Sans `project`, Ultralytics écrirait dans runs/ sous le dossier courant.
    metrics = model.val(data=str(data), split="val", plots=True, project=str(RUNS), name="validation", exist_ok=True)
    print(f"mAP50 {metrics.box.map50:.3f} · mAP50-95 {metrics.box.map:.3f}")
    print(f"meilleurs poids : {RUNS / 'detecteur' / 'weights' / 'best.pt'}")


if __name__ == "__main__":
    main()
