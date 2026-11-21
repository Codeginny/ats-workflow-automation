"""Arma las postulaciones de ejemplo a partir de demo/postulaciones.yaml.

Escribe una carpeta por oferta en postulaciones/ (oferta, análisis, CV adaptado en YAML y PDF,
carta y correo) y deja seguimiento.csv con una fila por postulación. Todo es ficticio y se
puede rehacer cuando se quiera: pisa lo que había.

Uso:
    python herramientas/datos_demo.py
"""
import copy
import json
import os
import re
import shutil
import unicodedata
from pathlib import Path

import yaml
from reportlab import rl_config

import generar_cv
import tracker

# PDF sin fecha de creación ni id al azar: rehacer la demo no cambia los archivos.
rl_config.invariant = 1

RAIZ = Path(os.environ.get("BUSCADOR_RAIZ") or Path(__file__).resolve().parent.parent).resolve()
DEMO = RAIZ / "demo" / "postulaciones.yaml"
MAESTRO = RAIZ / "perfil" / "cv_maestro.yaml"
POSTULACIONES = RAIZ / "postulaciones"


def slug(texto):
    sin_tildes = unicodedata.normalize("NFD", texto.lower())
    sin_tildes = "".join(c for c in sin_tildes if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]+", "-", sin_tildes).strip("-")


def analisis(o):
    filas = "\n".join(f"| {r} | {tiene} | {evidencia} |" for r, tiene, evidencia in o["requisitos"])
    brechas = "\n".join(f"- {b}" for b in o["brechas"])
    return (f"# Análisis — {o['puesto']} ({o['empresa']})\n\n"
            f"**Puntaje: {o['puntaje']}/100**: {o['detalle_puntaje']}.\n\n"
            f"| Requisito | ¿Lo tiene? | Evidencia en el CV maestro |\n|---|---|---|\n{filas}\n\n"
            f"## Brechas y cómo encararlas\n{brechas}\n\n"
            f"## Palabras clave\n{o['claves']}\n")


def relevancia(logro, claves):
    texto = logro.lower()
    return -sum(1 for c in claves if c.strip().lower() in texto)


def cv_adaptado(maestro, o):
    """Copia del maestro apuntada a la oferta: sólo cambia titular, perfil, orden y pretensión."""
    cv = copy.deepcopy(maestro)
    cv.pop("pendientes_de_verificar", None)
    d = cv["datos_personales"]
    d["titular"] = o["titular"]
    if o.get("mostrar_pretension"):
        d.update(pretension=o["pretension"], mostrar_pretension=True)
    cv["perfil"] = " ".join(o["perfil"].split())
    claves = o["claves"].split(",")
    for exp in cv["experiencia"]:
        exp["logros"].sort(key=lambda logro: relevancia(logro, claves))
    return cv


def armar(o, maestro):
    carpeta = POSTULACIONES / f"{o['fecha']}_{slug(o['empresa'])}_{slug(o['puesto'])}"
    shutil.rmtree(carpeta, ignore_errors=True)
    carpeta.mkdir(parents=True)
    rel = carpeta.relative_to(RAIZ).as_posix()
    (carpeta / "oferta.md").write_text(f"# {o['puesto']} — {o['empresa']}\n\nLink: {o['link']}\n\n{o['oferta']}",
                                       encoding="utf-8")
    (carpeta / "analisis.md").write_text(analisis(o), encoding="utf-8")
    fila = {c: "" for c in tracker.COLUMNAS}
    fila.update(id=str(o["id"]), fecha=o["fecha"], empresa=o["empresa"], puesto=o["puesto"],
                a_que_se_dedica=o["dedica"], requisitos_clave="; ".join(r[0] for r in o["requisitos"]),
                para_estudiar=o["estudiar"], contacto=o["contacto"], canal=o["canal"], link_oferta=o["link"],
                fuente=o["fuente"], salario_ofrecido=o["salario"], puntaje_match=str(o["puntaje"]),
                estado=tracker.ESTADOS[o["estado"]], proximo_seguimiento=o["proximo"], notas=o["notas"],
                revisada=o.get("revisada", ""))
    if not o["carta"]:  # descartada antes de preparar nada: sólo quedan la oferta y el análisis
        fila["carta"] = f"{rel}/analisis.md"
        return fila

    cv = cv_adaptado(maestro, o)
    (carpeta / "cv.yaml").write_text(yaml.safe_dump(cv, allow_unicode=True, sort_keys=False, width=1000),
                                     encoding="utf-8")
    pdf = carpeta / f"CV_Carolina_Mendez_{slug(o['empresa']).replace('-', '_').title()}.pdf"
    doc = generar_cv.SimpleDocTemplate(str(pdf), pagesize=generar_cv.A4, leftMargin=16 * generar_cv.mm,
                                       rightMargin=16 * generar_cv.mm, topMargin=14 * generar_cv.mm,
                                       bottomMargin=14 * generar_cv.mm, title="CV Carolina Méndez",
                                       author="Carolina Méndez")
    doc.build(generar_cv.construir(cv))
    (carpeta / "carta.md").write_text(o["carta"], encoding="utf-8")
    if o["canal"] == "email":
        correo = {"para": o["contacto"], "asunto": o["asunto"], "cuerpo": "carta.md",
                  "adjuntos": [pdf.relative_to(RAIZ).as_posix()]}
        (carpeta / "correo.json").write_text(json.dumps(correo, ensure_ascii=False, indent=2), encoding="utf-8")
    fila.update(carta=f"{rel}/carta.md", cv_usado=pdf.relative_to(RAIZ).as_posix())
    return fila


def main():
    maestro = yaml.safe_load(MAESTRO.read_text(encoding="utf-8"))
    ofertas = yaml.safe_load(DEMO.read_text(encoding="utf-8"))
    filas = [armar(o, maestro) for o in ofertas]
    tracker.guardar(sorted(filas, key=lambda f: int(f["id"])))
    print(f"Listo: {len(filas)} postulaciones de ejemplo en {POSTULACIONES.relative_to(RAIZ)}/ y seguimiento.csv")


if __name__ == "__main__":
    main()
