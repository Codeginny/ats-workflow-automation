"""Genera un CV en PDF apto para ATS a partir de un YAML con el formato de perfil/cv_maestro.yaml.

Diseño pensado para filtros ATS: una sola columna, sin tablas ni imágenes,
fuentes estándar, títulos de sección reconocibles y texto seleccionable.

Uso:
    python herramientas/generar_cv.py postulaciones/<carpeta>/cv.yaml postulaciones/<carpeta>/CV_Carolina_Mendez.pdf
"""
import sys
from pathlib import Path

import yaml
from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import HRFlowable, KeepTogether, ListFlowable, ListItem, Paragraph, SimpleDocTemplate, Spacer
from xml.sax.saxutils import escape

ACENTO = HexColor("#1F3A5F")
GRIS = HexColor("#444444")

# DejaVu trae los símbolos de contacto (✉ ☎ ⌂); si no está, se usa texto sin iconos.
try:
    pdfmetrics.registerFont(TTFont("Simbolos", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"))
    SIMBOLOS = True
except Exception:
    SIMBOLOS = False

E = {
    "nombre": ParagraphStyle("nombre", fontName="Helvetica-Bold", fontSize=18, leading=22, alignment=TA_CENTER, textColor=ACENTO),
    "titular": ParagraphStyle("titular", fontName="Helvetica", fontSize=10.5, leading=14, alignment=TA_CENTER, textColor=GRIS),
    "contacto": ParagraphStyle("contacto", fontName="Helvetica", fontSize=9, leading=12, alignment=TA_CENTER, textColor=GRIS),
    "seccion": ParagraphStyle("seccion", fontName="Helvetica-Bold", fontSize=11, leading=14, textColor=ACENTO, spaceBefore=8, spaceAfter=2),
    "puesto": ParagraphStyle("puesto", fontName="Helvetica-Bold", fontSize=10, leading=13, spaceBefore=4),
    "empresa": ParagraphStyle("empresa", fontName="Helvetica-Oblique", fontSize=9.5, leading=12, textColor=GRIS),
    "texto": ParagraphStyle("texto", fontName="Helvetica", fontSize=9.5, leading=12.5),
    "subtitulo": ParagraphStyle("subtitulo", fontName="Helvetica-Bold", fontSize=10, leading=13, textColor=ACENTO, spaceBefore=6, spaceAfter=3),
    "area": ParagraphStyle("area", fontName="Helvetica-Bold", fontSize=9, leading=12, textColor=GRIS, spaceBefore=5, spaceAfter=2),
    "formacion": ParagraphStyle("formacion", fontName="Helvetica", fontSize=9.5, leading=12.5, spaceAfter=1.5),
    "habilidad": ParagraphStyle("habilidad", fontName="Helvetica", fontSize=9.5, leading=13, spaceAfter=5),
}


def p(texto, estilo="texto"):
    return Paragraph(escape(str(texto)), E[estilo])


def seccion(titulo):
    return [p(titulo.upper(), "seccion"), HRFlowable(width="100%", thickness=0.6, color=ACENTO, spaceAfter=3)]


def viñetas(items):
    return ListFlowable(
        [ListItem(p(i), leftIndent=10) for i in items],
        bulletType="bullet", start="•", leftIndent=10, bulletFontSize=8,
    )


def lista_formacion(items):
    """Cada ítem «Título — Institución»: el título en negrita y la institución en gris, con aire entre ítems."""
    filas = []
    for i in items:
        titulo, _, lugar = str(i).partition(" — ")
        texto = f"<b>{escape(titulo)}</b>" + (f'&nbsp;&nbsp;<font color="#666666">{escape(lugar)}</font>' if lugar else "")
        filas.append(ListItem(Paragraph(texto, E["formacion"]), leftIndent=12))
    return ListFlowable(filas, bulletType="bullet", start="•", leftIndent=12, bulletFontSize=8, bulletColor=ACENTO)


def textos(nodo):
    """Recorre el YAML y devuelve todos los strings (para el control de VERIFICAR)."""
    if isinstance(nodo, dict):
        for k, v in nodo.items():
            if k not in ("pendientes_de_verificar", "nota_interna"):
                yield from textos(v)
    elif isinstance(nodo, list):
        for v in nodo:
            yield from textos(v)
    elif isinstance(nodo, str):
        yield nodo


def icono(simbolo):
    return f'<font name="Simbolos" color="#1F3A5F">{simbolo}</font>&nbsp;' if SIMBOLOS else ""


def linea_contacto(d):
    """Contacto con iconos, separado en items legibles (texto real, así el ATS lo lee igual)."""
    sep = '&nbsp;&nbsp;&nbsp;<font color="#BBBBBB">|</font>&nbsp;&nbsp;&nbsp;'
    items = []
    if d.get("email"):
        items.append(icono("✉") + f'<link href="mailto:{escape(d["email"])}">{escape(d["email"])}</link>')
    if d.get("telefono"):
        items.append(icono("☎") + escape(d["telefono"]))
    lugar = " · ".join(x for x in (d.get("ubicacion"), d.get("modalidad")) if x)
    if lugar:
        items.append(icono("⌂") + escape(lugar))
    if d.get("linkedin"):
        url = d["linkedin"] if d["linkedin"].startswith("http") else "https://" + d["linkedin"]
        items.append('<font backColor="#1F3A5F" color="white"><b>&nbsp;in&nbsp;</b></font>&nbsp;'
                     f'<link href="{escape(url)}">{escape(d["linkedin"])}</link>')
    # Sin cortes adentro de cada dato; 2 por renglón para que respire.
    items = [i.replace(" ", "&nbsp;") if "<" not in i else i for i in items]
    renglones = [sep.join(items[i:i + 2]) for i in range(0, len(items), 2)]
    return Paragraph("<br/>".join(renglones), ParagraphStyle("contacto2", parent=E["contacto"], leading=15))


def construir(cv):
    d = cv["datos_personales"]
    if d.get("iconos"):
        contacto = linea_contacto(d)
    else:
        contacto = p(" | ".join(c for c in [d.get("email"), d.get("telefono"), d.get("ubicacion"),
                                            d.get("modalidad"), d.get("linkedin")] if c), "contacto")
    flujo = [
        p(d["nombre"], "nombre"),
        Spacer(1, 2),
        p(d.get("titular", ""), "titular"),
        Spacer(1, 5),
        contacto,
        Spacer(1, 6),
    ]

    flujo += seccion("Perfil profesional") + [p(cv["perfil"].strip())]

    comercial = cv.get("experiencia_comercial")
    if comercial:
        flujo += seccion(comercial.get("titulo", "Experiencia comercial")) + [viñetas(comercial["items"])]

    flujo += seccion("Experiencia profesional")
    for exp in cv["experiencia"]:
        if exp.get("omitir"):
            continue
        bloque = [
            p(f"{exp['puesto']}  —  {exp['periodo']}", "puesto"),
            p(exp["empresa"], "empresa"),
            viñetas(exp["logros"]),
        ]
        flujo.append(KeepTogether(bloque))

    hab = cv.get("habilidades", {})
    if hab:
        nombres = {"comercial": "Comercial", "gestion": "Gestión de proyectos", "herramientas": "Herramientas", "ia": "Inteligencia artificial", "blandas": "Habilidades blandas"}
        filas = [Paragraph(f"<b>{escape(nombres.get(clave, clave[:1].upper() + clave[1:]))}:</b>&nbsp; "
                           + escape("  ·  ").join(escape(i) for i in items), E["habilidad"])
                 for clave, items in hab.items() if items]
        # El título nunca queda solo al pie de la página.
        flujo.append(KeepTogether(seccion("Habilidades y herramientas") + filas[:1]))
        flujo += filas[1:]

    form = cv.get("formacion", {})
    if form:
        flujo += seccion("Formación y certificaciones")
        if form.get("estudios"):
            flujo += [p("Estudios", "subtitulo"), lista_formacion(form["estudios"])]
        certs = form.get("certificaciones")
        if isinstance(certs, dict):  # agrupadas por área
            flujo.append(p("Certificaciones", "subtitulo"))
            for area, items in certs.items():
                flujo.append(KeepTogether([p(area, "area"), lista_formacion(items)]))
        elif certs:
            flujo += [p("Certificaciones", "subtitulo"), lista_formacion(certs)]

    idiomas = d.get("idiomas")
    if idiomas:
        flujo += seccion("Idiomas") + [p(" | ".join(idiomas))]

    # Sólo si la publicación habla de sueldo (publica un monto o pide la pretensión).
    if d.get("pretension") and d.get("mostrar_pretension"):
        flujo += [Spacer(1, 6), Paragraph(f"<b>Remuneración pretendida:</b> {escape(d['pretension'])}", E["texto"])]
    return flujo


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    origen, destino = Path(sys.argv[1]), Path(sys.argv[2])
    cv = yaml.safe_load(origen.read_text(encoding="utf-8"))

    sin_verificar = [t for t in textos(cv) if "VERIFICAR" in t]
    if sin_verificar:
        print("No genero el PDF: hay datos marcados VERIFICAR que irían al CV:")
        for t in sin_verificar:
            print("  -", t)
        sys.exit(1)

    destino.parent.mkdir(parents=True, exist_ok=True)
    nombre = cv["datos_personales"]["nombre"]
    doc = SimpleDocTemplate(
        str(destino), pagesize=A4,
        leftMargin=16 * mm, rightMargin=16 * mm, topMargin=14 * mm, bottomMargin=14 * mm,
        title=f"CV {nombre}", author=nombre,
    )
    doc.build(construir(cv))
    print(f"PDF generado: {destino}")


if __name__ == "__main__":
    main()
