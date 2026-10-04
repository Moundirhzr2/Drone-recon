"""Mesure le détecteur sur la validation, réglé comme dans le simulateur.

Le mAP d'Ultralytics balaie tous les seuils de confiance ; sa matrice de
confusion compte même les boîtes à 0,1 % de confiance. Le simulateur, lui,
retient les boîtes au-dessus de `CONFIG.model.confidence`, les fusionne sans
tenir compte de la classe, et rapproche chacune du bâtiment qu'elle recouvre
à plus de 50 % (voir `src/diagnostic/model.ts`). Ce script refait exactement
ce calcul sur les images de validation, pour savoir ce que l'on verra en vol :

- la matrice de confusion à ce point de fonctionnement ;
- les mesures du rapport : précision et rappel des alertes de dégâts, part
  des alertes justes qui ont aussi la bonne classe.

Usage : python evaluer.py <data.yaml> [poids]   (par défaut runs/detecteur/weights/best.pt)
"""

import json
import sys
from pathlib import Path

import yaml
from ultralytics import YOLO

ML = Path(__file__).resolve().parent
# Réglages du simulateur : CONFIG.model dans src/core/config.ts.
CONFIDENCE = 0.3
NMS_IOU = 0.6
MATCH_IOU = 0.5
# En dessous de MATCH_IOU mais au-dessus de ce recouvrement, une fausse alerte
# vise bien un bâtiment : c'est une erreur de cadrage (« boîte imprécise »).
LOOSE_IOU = 0.1


def iou(a: list[float], b: list[float]) -> float:
    """Recouvrement de deux boîtes [x1, y1, x2, y2]."""
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    if w <= 0 or h <= 0:
        return 0.0
    inter = w * h
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)


def truth_of(label: Path, width: int, height: int) -> list[tuple[int, list[float]]]:
    """Étiquettes YOLO (centre et taille normalisés) -> boîtes en pixels."""
    boxes = []
    if label.exists():
        for line in label.read_text(encoding="utf-8").split("\n"):
            if not line.strip():
                continue
            cls, cx, cy, w, h = line.split()
            cx, cy, w, h = float(cx) * width, float(cy) * height, float(w) * width, float(h) * height
            boxes.append((int(cls), [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2]))
    return boxes


def main() -> None:
    data = Path(sys.argv[1]).resolve()
    weights = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else ML / "runs" / "detecteur" / "weights" / "best.pt"
    config = yaml.safe_load(data.read_text(encoding="utf-8"))
    names = [config["names"][i] for i in sorted(config["names"])]
    root = Path(config["path"])
    images = sorted((root / config["val"]).glob("*.jpg"))
    n = len(names)
    background = n

    # matrice[prédit][réel], la dernière ligne et la dernière colonne pour le fond.
    matrix = [[0] * (n + 1) for _ in range(n + 1)]
    alerts_ok = alerts_wrong = damaged = right_class = loose = 0

    model = YOLO(str(weights))
    results = model.predict(
        [str(p) for p in images],
        imgsz=640,
        conf=CONFIDENCE,
        iou=NMS_IOU,
        agnostic_nms=True,
        stream=True,
        verbose=False,
    )
    for image, result in zip(images, results):
        height, width = result.orig_shape
        label = root / "labels" / image.parent.name / f"{image.stem}.txt"
        truth = truth_of(label, width, height)
        damaged += sum(1 for cls, _ in truth if cls != 0)
        taken: set[int] = set()

        order = result.boxes.conf.argsort(descending=True).tolist()
        for k in order:
            cls = int(result.boxes.cls[k])
            box = result.boxes.xyxy[k].tolist()
            best, match = MATCH_IOU, -1
            for j, (_, t) in enumerate(truth):
                if j in taken:
                    continue
                overlap = iou(box, t)
                if overlap >= best:
                    best, match = overlap, j
            real = truth[match][0] if match >= 0 else background
            if match >= 0:
                taken.add(match)
            matrix[cls][real] += 1
            # Une alerte, c'est une boîte d'une classe de dégâts.
            if cls != 0:
                if real not in (0, background):
                    alerts_ok += 1
                    right_class += real == cls
                else:
                    alerts_wrong += 1
                    if match < 0 and any(iou(box, t) >= LOOSE_IOU for _, t in truth):
                        loose += 1
        for j, (cls, _) in enumerate(truth):
            if j not in taken:
                matrix[background][cls] += 1

    labels = names + ["(rien)"]
    print(f"{len(images)} images de validation · confiance {CONFIDENCE} · rapprochement à IoU {MATCH_IOU}")
    print("\nprédit \\ réel".ljust(16) + "".join(f"{l:>11}" for l in labels))
    for i, row in enumerate(matrix):
        print(labels[i].ljust(15) + "".join(f"{v:>11}" for v in row))

    per_class = {}
    for i, name in enumerate(names):
        found = matrix[i][i]
        predicted = sum(matrix[i])
        real = sum(matrix[r][i] for r in range(n + 1))
        per_class[name] = {
            "précision": round(found / predicted, 3) if predicted else None,
            "rappel": round(found / real, 3) if real else None,
            "réels": real,
        }
    alerts = alerts_ok + alerts_wrong
    report = {
        "images": len(images),
        "confiance": CONFIDENCE,
        "classes": per_class,
        "alertes": {
            "précision": round(alerts_ok / alerts, 3) if alerts else None,
            "rappel": round(alerts_ok / damaged, 3) if damaged else None,
            "classe juste": round(right_class / alerts_ok, 3) if alerts_ok else None,
            "dégâts réels": damaged,
            "alertes": alerts,
            "fausses alertes": alerts_wrong,
            "dont boîtes imprécises": loose,
        },
        "matrice": {"lignes (prédit)": labels, "colonnes (réel)": labels, "valeurs": matrix},
    }
    print("\npar classe :")
    for name, m in per_class.items():
        print(f"  {name:<10} précision {m['précision']}  rappel {m['rappel']}  ({m['réels']} réels)")
    print("\nalertes de dégâts, comme dans le rapport du simulateur :")
    print(f"  {json.dumps(report['alertes'], ensure_ascii=False)}")

    out = weights.parent.parent / "evaluation.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\nécrit : {out}")


if __name__ == "__main__":
    main()
