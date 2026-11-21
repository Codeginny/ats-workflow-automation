"""Cuadro de seguimiento de postulaciones (seguimiento.csv).

Uso:
    python herramientas/tracker.py agregar --empresa X --puesto Y [--dedica "a qué se dedica"] [--requisitos ...]
           [--estudiar "tema 1; tema 2; tema 3"]
           [--contacto ...] [--canal ...] [--link ...] [--fuente ...] [--salario ...]
           [--puntaje 85] [--carta ruta] [--cv ruta] [--estado preparada] [--notas ...]
    python herramientas/tracker.py estado <id> <estado> [--notas "texto"]
    python herramientas/tracker.py listar [--estado enviado]
    python herramientas/tracker.py seguimientos        # a quién hay que escribirle hoy
    python herramientas/tracker.py panel [--abrir]     # genera panel.html (y lo abre en el navegador)
    python herramientas/tracker.py excel               # genera seguimiento.xlsx (requiere openpyxl)
"""
import os
import argparse
import csv
import html
from datetime import date, timedelta
from pathlib import Path

RAIZ = Path(os.environ.get("BUSCADOR_RAIZ") or Path(__file__).resolve().parent.parent).resolve()
CSV = RAIZ / "seguimiento.csv"

COLUMNAS = [
    "id", "fecha", "empresa", "puesto", "a_que_se_dedica", "requisitos_clave", "para_estudiar", "contacto", "canal",
    "link_oferta", "fuente", "salario_ofrecido", "puntaje_match", "carta", "cv_usado",
    "estado", "proximo_seguimiento", "notas", "revisada",
]

ESTADOS = {
    "preparada": "📝 Revisar",
    "pendiente_envio": "📬 Pendiente para enviar",
    "enviado": "📤 Enviado",
    "entrevista": "🎉 Entrevista",
    "entrevista_2": "💼 2da Entrevista",
    "rechazado": "🙅 En esta oportunidad no",
    "cerrada": "🔒 Cerró la propuesta",
    "descartada": "🗑️ Descartada",
}
SIN_ENVIAR = ("preparada", "pendiente_envio")
# Las que no cuentan como enviadas aunque no estén «sin enviar».
NO_ENVIADAS = SIN_ENVIAR + ("descartada",)
# Estados viejos → nuevos (para leer filas guardadas antes del cambio de estados).
ESTADOS_VIEJOS = {
    "📝 Preparada (sin enviar)": "preparada", "🟡 Pendiente": "enviado", "🟢 Recibido / En proceso": "enviado",
    "🔴 Rechazado": "rechazado", "⭐ Entrevista": "entrevista", "🏆 Oferta": "entrevista_2", "⚪ Sin respuesta": "enviado",
    "pendiente": "enviado", "en_proceso": "enviado", "sin_respuesta": "enviado", "oferta": "entrevista_2",
}
# Días hasta el próximo seguimiento según el estado (None = no hace falta).
DIAS_SEGUIMIENTO = {"enviado": 7, "entrevista": 2, "entrevista_2": 2}


def leer():
    if not CSV.exists():
        return []
    with CSV.open(encoding="utf-8", newline="") as f:
        filas = [{c: fila.get(c) or "" for c in COLUMNAS} for fila in csv.DictReader(f)]
    for f in filas:  # pasa los estados viejos a los nuevos
        if f["estado"] in ESTADOS_VIEJOS:
            f["estado"] = ESTADOS[ESTADOS_VIEJOS[f["estado"]]]
    return filas


def guardar(filas):
    with CSV.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNAS)
        w.writeheader()
        w.writerows(filas)


def clave_estado(texto):
    for k, v in ESTADOS.items():
        if texto in (k, v):
            return k
    if texto in ESTADOS_VIEJOS:
        return ESTADOS_VIEJOS[texto]
    raise SystemExit(f"Estado desconocido: {texto}. Opciones: {', '.join(ESTADOS)}")


def proximo(estado):
    dias = DIAS_SEGUIMIENTO.get(estado)
    return (date.today() + timedelta(days=dias)).isoformat() if dias else ""


def agregar(a):
    filas = leer()
    duplicada = [f for f in filas if f["empresa"].lower() == a.empresa.lower() and f["puesto"].lower() == a.puesto.lower()]
    if duplicada and not a.forzar:
        raise SystemExit(f"Ya existe una postulación a {a.puesto} en {a.empresa} (id {duplicada[0]['id']}). Usá --forzar si es otra.")
    estado = clave_estado(a.estado)
    fila = {
        "id": str(max((int(f["id"]) for f in filas), default=0) + 1),
        "fecha": date.today().isoformat(), "empresa": a.empresa, "puesto": a.puesto,
        "a_que_se_dedica": a.dedica, "requisitos_clave": a.requisitos, "para_estudiar": a.estudiar,
        "contacto": a.contacto, "canal": a.canal,
        "link_oferta": a.link, "fuente": a.fuente, "salario_ofrecido": a.salario,
        "puntaje_match": a.puntaje, "carta": a.carta, "cv_usado": a.cv,
        "estado": ESTADOS[estado], "proximo_seguimiento": proximo(estado), "notas": a.notas, "revisada": "",
    }
    filas.append(fila)
    guardar(filas)
    print(f"Agregada #{fila['id']}: {a.puesto} en {a.empresa} — {fila['estado']}")


def cambiar_estado(a):
    filas = leer()
    estado = clave_estado(a.estado)
    for f in filas:
        if f["id"] == a.id:
            if clave_estado(f["estado"]) in SIN_ENVIAR and estado not in SIN_ENVIAR:
                f["fecha"] = date.today().isoformat()  # la fecha cuenta desde el envío real
            f["estado"] = ESTADOS[estado]
            f["proximo_seguimiento"] = proximo(estado)
            if a.notas:
                f["notas"] = (f["notas"] + f" | {date.today()}: {a.notas}").strip(" |")
            guardar(filas)
            print(f"#{f['id']} {f['empresa']} → {f['estado']}")
            return
    raise SystemExit(f"No existe la postulación #{a.id}")


def listar(a):
    filas = leer()
    if a.estado:
        filas = [f for f in filas if f["estado"] == ESTADOS[clave_estado(a.estado)]]
    for f in filas:
        print(f"#{f['id']:>3} {f['fecha']}  {f['estado']:<26} {f['puntaje_match']:>3}  {f['puesto']} — {f['empresa']}")
    print(f"\nTotal: {len(filas)}")


def seguimientos(_):
    hoy = date.today().isoformat()
    vencidos = [f for f in leer() if f["proximo_seguimiento"] and f["proximo_seguimiento"] <= hoy]
    if not vencidos:
        print("Nada para hacer seguimiento hoy.")
    for f in vencidos:
        print(f"#{f['id']} {f['empresa']} ({f['puesto']}) — {f['estado']} desde {f['fecha']} — contacto: {f['contacto'] or f['canal']}")


def panel(a):
    filas = leer()
    conteo = {v: sum(f["estado"] == v for f in filas) for v in ESTADOS.values()}
    tarjetas = "".join(f"<div class=t><b>{n}</b><span>{html.escape(e)}</span></div>" for e, n in conteo.items())
    cab = "".join(f"<th>{c.replace('_', ' ')}</th>" for c in COLUMNAS)

    def celda(c, v):
        v = html.escape(v)
        if c == "link_oferta" and v:
            return f'<td><a href="{v}" target=_blank>ver</a></td>'
        if c in ("para_estudiar", "requisitos_clave") and ";" in v:
            return "<td><ul>" + "".join(f"<li>{i.strip()}</li>" for i in v.split(";") if i.strip()) + "</ul></td>"
        return f"<td>{v}</td>"

    cuerpo = "".join("<tr>" + "".join(celda(c, f[c]) for c in COLUMNAS) + "</tr>" for f in reversed(filas))
    (RAIZ / "panel.html").write_text(f"""<!doctype html><meta charset=utf-8><title>Postulaciones de Carolina</title>
<style>body{{font:14px system-ui;margin:24px;background:#f7f8fa;color:#1d2433}}h1{{margin:0 0 16px}}
.ts{{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px}}.t{{background:#fff;border-radius:10px;padding:12px 16px;box-shadow:0 1px 3px #0001}}
.t b{{display:block;font-size:24px}}table{{border-collapse:collapse;background:#fff;width:100%;font-size:12px}}
th,td{{border-bottom:1px solid #e5e7eb;padding:6px 8px;text-align:left;vertical-align:top}}th{{background:#1F3A5F;color:#fff;position:sticky;top:0}}
.w{{overflow-x:auto}}ul{{margin:0;padding-left:16px}}td{{min-width:90px}}</style><h1>Postulaciones de Carolina ({len(filas)})</h1><div class=ts>{tarjetas}</div>
<div class=w><table><tr>{cab}</tr>{cuerpo}</table></div><p>Actualizado: {date.today()}</p>""", encoding="utf-8")
    print(f"Panel generado: {RAIZ / 'panel.html'}")
    if a.abrir:
        import webbrowser
        webbrowser.open((RAIZ / "panel.html").as_uri())


def excel(_):
    try:
        from openpyxl import Workbook
        from openpyxl.worksheet.datavalidation import DataValidation
    except ImportError:
        raise SystemExit("Falta openpyxl: pip install openpyxl") from None
    wb = Workbook()
    ws = wb.active
    ws.title = "Postulaciones"
    ws.append(COLUMNAS)
    for f in leer():
        ws.append([f[c] for c in COLUMNAS])
    dv = DataValidation(type="list", formula1='"' + ",".join(ESTADOS.values()) + '"')
    col = chr(ord("A") + COLUMNAS.index("estado"))
    dv.add(f"{col}2:{col}1000")
    ws.add_data_validation(dv)
    ws.freeze_panes = "A2"
    wb.save(RAIZ / "seguimiento.xlsx")
    print(f"Excel generado: {RAIZ / 'seguimiento.xlsx'} (columna Estado con selector)")


def main():
    ap = argparse.ArgumentParser(description="Seguimiento de postulaciones")
    sub = ap.add_subparsers(dest="cmd", required=True)

    ag = sub.add_parser("agregar")
    ag.add_argument("--empresa", required=True)
    ag.add_argument("--puesto", required=True)
    for campo in ("dedica", "requisitos", "estudiar", "contacto", "canal", "link", "fuente", "salario", "puntaje", "carta", "cv", "notas"):
        ag.add_argument(f"--{campo}", default="")
    ag.add_argument("--estado", default="preparada")
    ag.add_argument("--forzar", action="store_true")
    ag.set_defaults(func=agregar)

    es = sub.add_parser("estado")
    es.add_argument("id")
    es.add_argument("estado")
    es.add_argument("--notas", default="")
    es.set_defaults(func=cambiar_estado)

    li = sub.add_parser("listar")
    li.add_argument("--estado")
    li.set_defaults(func=listar)

    sub.add_parser("seguimientos").set_defaults(func=seguimientos)
    pa = sub.add_parser("panel")
    pa.add_argument("--abrir", action="store_true")
    pa.set_defaults(func=panel)
    sub.add_parser("excel").set_defaults(func=excel)

    a = ap.parse_args()
    a.func(a)


if __name__ == "__main__":
    main()
