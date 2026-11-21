"""Envía la postulación por correo (Gmail u otro SMTP) con el CV adjunto.

Por defecto NO envía: muestra una vista previa. Para enviar hay que pasar
--enviar y además escribir "SI" cuando lo pide. Así nada sale sin que Carolina lo lea.

Configuración: copiar .env.ejemplo a .env y completar. Para Gmail se usa una
"contraseña de aplicación" (https://myaccount.google.com/apppasswords), nunca la contraseña normal.

Uso:
    python herramientas/enviar_correo.py --para rrhh@empresa.com --asunto "Postulación: Project Manager" \
        --cuerpo postulaciones/<carpeta>/carta.md --adjunto postulaciones/<carpeta>/CV_Carolina_Mendez.pdf [--enviar]
"""
import argparse
import os
import re
import smtplib
import ssl
from email.message import EmailMessage
from pathlib import Path

RAIZ = Path(os.environ.get("BUSCADOR_RAIZ") or Path(__file__).resolve().parent.parent).resolve()


def cargar_env():
    env = RAIZ / ".env"
    if env.exists():
        for linea in env.read_text(encoding="utf-8").splitlines():
            if "=" in linea and not linea.lstrip().startswith("#"):
                k, v = linea.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"'))


FIRMA = RAIZ / "perfil" / "firma.txt"


def con_firma(cuerpo):
    """Las cartas no llevan firma: se agrega acá porque Gmail no la pone en los envíos por SMTP."""
    cuerpo = cuerpo.strip()
    firma = FIRMA.read_text(encoding="utf-8").strip() if FIRMA.exists() else ""
    if firma and firma.splitlines()[-1].strip() not in cuerpo:
        cuerpo += "\n\n" + firma
    return cuerpo


def armar_mensaje(para, asunto, cuerpo, adjuntos):
    """Arma el EmailMessage. `cuerpo` es el texto ya leído; `adjuntos` son rutas a PDFs."""
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", para):
        raise ValueError(f"Dirección inválida: {para}")
    cargar_env()
    remitente = os.environ.get("SMTP_USUARIO", "")
    nombre = os.environ.get("NOMBRE_REMITENTE", "Carolina Méndez")
    msg = EmailMessage()
    msg["From"] = f"{nombre} <{remitente}>"
    msg["To"] = para
    msg["Subject"] = asunto
    if os.environ.get("CCO_COPIA"):
        msg["Bcc"] = os.environ["CCO_COPIA"]
    msg.set_content(con_firma(cuerpo))
    for ruta in map(Path, adjuntos):
        msg.add_attachment(ruta.read_bytes(), maintype="application", subtype="pdf", filename=ruta.name)
    return msg


def smtp_configurado():
    cargar_env()
    return bool(os.environ.get("SMTP_USUARIO") and os.environ.get("SMTP_CLAVE"))


def enviar(msg):
    if not smtp_configurado():
        raise RuntimeError("Faltan SMTP_USUARIO / SMTP_CLAVE en .env")
    host = os.environ.get("SMTP_SERVIDOR", "smtp.gmail.com")
    puerto = int(os.environ.get("SMTP_PUERTO", "465"))
    with smtplib.SMTP_SSL(host, puerto, context=ssl.create_default_context()) as s:
        s.login(os.environ["SMTP_USUARIO"], os.environ["SMTP_CLAVE"])
        s.send_message(msg)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--para", required=True)
    ap.add_argument("--asunto", required=True)
    ap.add_argument("--cuerpo", required=True, help="archivo de texto con la carta")
    ap.add_argument("--adjunto", action="append", default=[])
    ap.add_argument("--enviar", action="store_true")
    a = ap.parse_args()

    cuerpo = Path(a.cuerpo).read_text(encoding="utf-8").strip()
    try:
        msg = armar_mensaje(a.para, a.asunto, cuerpo, a.adjunto)
    except ValueError as e:
        raise SystemExit(str(e)) from None

    print("=" * 60)
    print(f"De:      {msg['From']}\nPara:    {a.para}\nAsunto:  {a.asunto}")
    print(f"Adjuntos: {', '.join(Path(r).name for r in a.adjunto) or 'ninguno'}")
    print("-" * 60 + f"\n{cuerpo}\n" + "=" * 60)

    if not a.enviar:
        print("Vista previa: no se envió nada. Repetí con --enviar para mandarlo.")
        return
    if not smtp_configurado():
        raise SystemExit("Faltan SMTP_USUARIO / SMTP_CLAVE en .env")
    if input('¿Enviar este correo? Escribí "SI" para confirmar: ').strip() != "SI":
        print("Cancelado.")
        return
    enviar(msg)
    print(f"Enviado a {a.para}.")


if __name__ == "__main__":
    main()
