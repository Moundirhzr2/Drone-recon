"""Exporte le détecteur entraîné en ONNX, pour le simulateur.

Le modèle part dans `public/models/` avec une fiche JSON qui dit au navigateur
comment le lire : taille d'entrée, classes, conditions d'entraînement et scores
de validation. Le simulateur ne connaît que ce contrat : un autre détecteur au
même format de sortie (celui de YOLO) se branche en remplaçant ces deux
fichiers.

La sortie reste brute (`nms=False`) : le tri des boîtes se fait dans le
navigateur, ce qui garde le graphe ONNX simple et lisible par onnxruntime-web.

Un fichier de poids `.pt` est un fichier pickle : le charger peut exécuter du
code. N'exporter que des poids dont on connaît l'origine, comme ceux que
produit `entrainer.py`.

Usage : python exporter.py [poids .pt]   (par défaut runs/detecteur/weights/best.pt)
"""

import csv
import json
import shutil
import sys
from datetime import datetime
from pathlib import Path

from ultralytics import YOLO

ML = Path(__file__).resolve().parent
PUBLIC = ML.parent / "public" / "models"
IMGSZ = 640
# Hauteur de vol des images d'entraînement : voir CONFIG.dataset.altitude.
ALTITUDE = 60


def epoch_of(weights: Path, checkpoint: dict, metrics: dict) -> int:
    """Passe d'où viennent les poids, comptée à partir de 1.

    En fin d'entraînement, Ultralytics remet le compteur des poids à -1 : on
    retrouve alors la passe dans le journal, par ses scores de validation.
    """
    epoch = int(checkpoint.get("epoch", -1))
    if epoch >= 0:
        return epoch + 1
    journal = weights.parent.parent / "results.csv"
    if not journal.exists() or "metrics/mAP50-95(B)" not in metrics:
        return 0
    with journal.open(encoding="utf-8") as f:
        rows = [{k.strip(): v for k, v in row.items()} for row in csv.DictReader(f)]
    best = min(rows, key=lambda r: abs(float(r["metrics/mAP50-95(B)"]) - metrics["metrics/mAP50-95(B)"]))
    return int(best["epoch"])


def main() -> None:
    weights = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ML / "runs" / "detecteur" / "weights" / "best.pt"
    # Ultralytics garde le contenu des poids : inutile de les charger une seconde fois.
    model = YOLO(str(weights))
    checkpoint = model.ckpt or {}
    metrics = checkpoint.get("train_metrics") or {}
    onnx = Path(model.export(format="onnx", imgsz=IMGSZ, simplify=True, dynamic=False, nms=False, device="cpu"))

    PUBLIC.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(onnx, PUBLIC / "detecteur.onnx")
    card = {
        "name": "YOLO11n — Drone Recon",
        "format": "yolo",
        "inputSize": IMGSZ,
        "classes": [model.names[i] for i in sorted(model.names)],
        "trainedAltitude": ALTITUDE,
        "epoch": epoch_of(weights, checkpoint, metrics),
        "validation": {
            "mAP50": round(float(metrics.get("metrics/mAP50(B)", 0)), 3),
            "mAP50-95": round(float(metrics.get("metrics/mAP50-95(B)", 0)), 3),
            "precision": round(float(metrics.get("metrics/precision(B)", 0)), 3),
            "recall": round(float(metrics.get("metrics/recall(B)", 0)), 3),
        },
        "exportedAt": datetime.now().isoformat(timespec="seconds"),
    }
    (PUBLIC / "detecteur.json").write_text(
        json.dumps(card, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
    )

    size = (PUBLIC / "detecteur.onnx").stat().st_size / 1e6
    print(f"modèle : {PUBLIC / 'detecteur.onnx'} ({size:.1f} Mo)")
    print(f"fiche : {json.dumps(card, ensure_ascii=False)}")


if __name__ == "__main__":
    main()
