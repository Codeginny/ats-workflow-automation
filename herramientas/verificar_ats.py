"""Lee el PDF como lo haría un ATS y mide qué palabras clave de la oferta aparecen.

Uso:
    python herramientas/verificar_ats.py CV.pdf "Jira" "Scrum" "gestión de riesgos" ...
    python herramientas/verificar_ats.py CV.pdf --archivo palabras_clave.txt   (una por línea)

Sale con código 1 si el PDF no tiene texto extraíble o la cobertura es menor al 70%.
"""
import subprocess
import sys
import unicodedata
from pathlib import Path


def normalizar(texto):
    sin_tildes = unicodedata.normalize("NFD", texto.lower())
    return "".join(c for c in sin_tildes if unicodedata.category(c) != "Mn")


def texto_del_pdf(ruta):
    try:
        return subprocess.run(["pdftotext", "-layout", str(ruta), "-"], capture_output=True, text=True, check=True).stdout
    except FileNotFoundError:
        from pypdf import PdfReader  # alternativa si no está poppler-utils
        return "\n".join(pag.extract_text() or "" for pag in PdfReader(str(ruta)).pages)


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    pdf = Path(sys.argv[1])
    if sys.argv[2] == "--archivo":
        claves = [l.strip() for l in Path(sys.argv[3]).read_text(encoding="utf-8").splitlines() if l.strip()]
    else:
        claves = sys.argv[2:]

    texto = normalizar(" ".join(texto_del_pdf(pdf).split()))
    if len(texto) < 200:
        sys.exit("El PDF casi no tiene texto extraíble: un ATS lo leería vacío.")

    presentes = [c for c in claves if normalizar(c) in texto]
    faltan = [c for c in claves if c not in presentes]
    cobertura = round(100 * len(presentes) / len(claves))

    print(f"Cobertura de palabras clave: {cobertura}% ({len(presentes)}/{len(claves)})")
    print("Presentes:", ", ".join(presentes) or "-")
    print("Faltan:   ", ", ".join(faltan) or "-")
    if faltan:
        print("\nAgregá las que falten SÓLO si Carolina realmente tiene esa experiencia (revisá perfil/cv_maestro.yaml).")
    sys.exit(0 if cobertura >= 70 else 1)


if __name__ == "__main__":
    main()
