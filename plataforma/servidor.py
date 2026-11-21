"""Plataforma web local para manejar postulaciones (compu y celular). Los datos de la persona
viven en su carpeta (BUSCADOR_RAIZ), con `perfil/persona.json`.

Uso:
    .venv/bin/python plataforma/servidor.py            # puerto 8765
    .venv/bin/python plataforma/servidor.py --puerto 9000

Se abre en http://localhost:8765 y, desde el celular conectado al mismo Wi-Fi,
en http://<IP-de-la-compu>:8765. Pide una clave que se muestra al arrancar.
"""
import argparse
import json
import random
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
from datetime import date, datetime, timedelta
from glob import glob
from pathlib import Path

from flask import Flask, abort, jsonify, make_response, redirect, request, send_from_directory

RAIZ = Path(os.environ.get("BUSCADOR_RAIZ") or Path(__file__).resolve().parent.parent).resolve()
ESTATICOS = Path(__file__).resolve().parent / "static"
ENTRADAS = RAIZ / "entradas"
PROGRESO = RAIZ / "progreso_estudio.json"
ARCHIVO_CLAVE = RAIZ / ".panel_clave"

# Quién usa esta plataforma (cambia en cada carpeta de datos).
PERSONA = {"apodo": "Caro", "nombre": "Carolina", "archivo_cv": "CV_Carolina_Mendez"}
if (RAIZ / "perfil" / "persona.json").exists():
    PERSONA.update(json.loads((RAIZ / "perfil" / "persona.json").read_text(encoding="utf-8")))
APODO, NOMBRE = PERSONA["apodo"], PERSONA["nombre"]
COOKIE = "clave"



def personalizar(texto):
    """Cambia el nombre de la persona de ejemplo por el de esta carpeta (HTML y JS)."""
    if APODO == "Caro":
        return texto
    return texto.replace("Caro", APODO).replace("Carolina", NOMBRE)


sys.path.insert(0, str(RAIZ / "herramientas"))
import enviar_correo  # noqa: E402
import generar_cv  # noqa: E402
import yaml  # noqa: E402
import tracker  # noqa: E402
import verificar_ats  # noqa: E402

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024
cerrojo_csv = threading.Lock()
cola = threading.Semaphore(1)  # una oferta por vez: el tracker numera las filas
cola_fondo = threading.Semaphore(1)  # el diccionario va por su fila: no traba los CV ni las ofertas
TIPOS_DE_FONDO = ("palabras", "preguntas")
# Modelo y tope de turnos por tipo de trabajo, para gastar menos tokens: Haiku para lo
# mecánico, Sonnet para lo que escribe CV y cartas. Se pisa con "modelos" en perfil/config.json.
MODELOS = {"oferta": "sonnet", "cv": "sonnet", "busqueda": "sonnet", "curso": "haiku", "plan": "haiku",
           "palabras": "haiku", "palabra": "haiku", "preguntas": "haiku"}
MAX_TURNOS = {"oferta": 60, "cv": 30, "busqueda": 80, "palabras": 15, "palabra": 8, "preguntas": 20, "plan": 15, "curso": 20}


# ---------------------------------------------------------------- acceso

def clave_panel():
    if not ARCHIVO_CLAVE.exists():
        ARCHIVO_CLAVE.write_text(f"{secrets.randbelow(900000) + 100000}", encoding="utf-8")
    return ARCHIVO_CLAVE.read_text(encoding="utf-8").strip()


@app.before_request
def exigir_clave():
    if request.path in ("/login", "/static/app.css") or request.path.startswith("/static/icono"):
        return None
    if request.cookies.get(COOKIE) == clave_panel():
        return None
    if request.path.startswith("/api/") or request.path.startswith("/archivos/"):
        return jsonify(error="Sin acceso"), 401
    return redirect("/login")


@app.route("/login", methods=["GET", "POST"])
def login():
    error = ""
    if request.method == "POST":
        if request.form.get("clave", "").strip() == clave_panel():
            r = make_response(redirect("/"))
            r.set_cookie(COOKIE, clave_panel(), max_age=60 * 60 * 24 * 365, httponly=True, samesite="Lax")
            return r
        error = '<p class="login-error" role="alert">Clave incorrecta.</p>'
    html = personalizar((ESTATICOS / "login.html").read_text(encoding="utf-8"))
    return html.replace("<!--ERROR-->", error)


# ---------------------------------------------------------------- páginas y archivos

def pagina_personalizada(nombre, tipo):
    r = make_response(personalizar((ESTATICOS / nombre).read_text(encoding="utf-8")))
    r.headers["Content-Type"] = f"{tipo}; charset=utf-8"
    r.headers["Cache-Control"] = "no-cache"
    return r


@app.get("/")
def inicio():
    return pagina_personalizada("index.html", "text/html")


@app.get("/static/<path:archivo>")
def estaticos(archivo):
    if archivo == "app.js":
        return pagina_personalizada("app.js", "text/javascript")
    return send_from_directory(ESTATICOS, archivo)


@app.get("/archivos/<path:ruta>")
def archivos(ruta):
    destino = (RAIZ / ruta).resolve()
    permitidas = [(RAIZ / "postulaciones").resolve(), ENTRADAS.resolve()]
    if not any(destino.is_relative_to(p) for p in permitidas) or not destino.is_file():
        abort(404)
    return send_from_directory(destino.parent, destino.name)


# ---------------------------------------------------------------- postulaciones

def carpeta_de(fila):
    for campo in ("cv_usado", "carta"):
        if fila.get(campo):
            carpeta = (RAIZ / fila[campo]).parent
            if carpeta.is_dir():
                return carpeta
    return None


def leer_texto(ruta):
    return ruta.read_text(encoding="utf-8") if ruta and ruta.is_file() else ""


def progreso():
    try:
        return json.loads(PROGRESO.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def palabras_clave(analisis):
    """Lee la lista de la sección «Palabras clave» del análisis."""
    m = re.search(r"^#+\s*Palabras clave[^\n]*\n+(.+?)(?:\n\s*\n|\Z)", analisis, re.M | re.S)
    if not m:
        return []
    texto = re.sub(r"[*_`]", "", m.group(1)).strip().rstrip(".")
    vistas, claves = set(), []
    for parte in re.split(r",|;|\n-", texto):
        parte = parte.strip(" -.")
        if parte and len(parte) < 60 and parte.lower() not in vistas:
            vistas.add(parte.lower())
            claves.append(parte)
    return claves


def chequeo_ats(carpeta, analisis):
    claves = palabras_clave(analisis)
    pdfs = sorted(carpeta.glob("*.pdf"))
    if not claves or not pdfs:
        return None
    try:
        texto = verificar_ats.normalizar(" ".join(verificar_ats.texto_del_pdf(pdfs[0]).split()))
    except Exception:  # noqa: BLE001 - si no se puede leer el PDF, no se muestra el chequeo
        return None
    faltan = [c for c in claves if verificar_ats.normalizar(c) not in texto]
    return {"cobertura": round(100 * (len(claves) - len(faltan)) / len(claves)), "total": len(claves),
            "presentes": [c for c in claves if c not in faltan], "faltan": faltan}


def serializar(fila):
    carpeta = carpeta_de(fila)
    rel = carpeta.relative_to(RAIZ).as_posix() if carpeta else ""
    clave = next((k for k, v in tracker.ESTADOS.items() if v == fila["estado"]), "preparada")
    correo = {}
    if carpeta and (carpeta / "correo.json").exists():
        correo = json.loads((carpeta / "correo.json").read_text(encoding="utf-8"))
    pdfs = sorted(p.name for p in carpeta.glob("*.pdf")) if carpeta else []
    analisis = leer_texto(carpeta / "analisis.md") if carpeta else ""
    return {
        **fila,
        "estado_clave": clave,
        "carpeta": rel,
        "pdfs": [f"{rel}/{p}" for p in pdfs],
        "carta_texto": leer_texto(carpeta / "carta.md") if carpeta else "",
        "analisis": analisis,
        "ats": chequeo_ats(carpeta, analisis) if carpeta else None,
        "enviada": clave not in tracker.NO_ENVIADAS,
        "revisada_bool": fila.get("revisada") == "si",
        "correo": correo,
        "estudiado": progreso().get(fila["id"], []),
        "seguimiento_vencido": bool(fila["proximo_seguimiento"]) and fila["proximo_seguimiento"] <= date.today().isoformat(),
    }


@app.get("/api/postulaciones")
def listar():
    return jsonify(
        postulaciones=[serializar(f) for f in reversed(tracker.leer())],
        estados=[{"clave": k, "etiqueta": v} for k, v in tracker.ESTADOS.items()],
        smtp=enviar_correo.smtp_configurado(),
        estudio_activo=estudio_activo(),
        firma=leer_texto(enviar_correo.FIRMA).strip(),
        persona={"apodo": APODO},
    )


@app.patch("/api/postulaciones/<id_>")
def actualizar(id_):
    datos = request.get_json(force=True)
    with cerrojo_csv:
        filas = tracker.leer()
        fila = next((f for f in filas if f["id"] == id_), None)
        if not fila:
            abort(404)
        if "estado" in datos:
            nuevo = tracker.clave_estado(datos["estado"])
            if tracker.clave_estado(fila["estado"]) in tracker.SIN_ENVIAR and nuevo not in tracker.SIN_ENVIAR:
                fila["fecha"] = date.today().isoformat()
            fila["estado"] = tracker.ESTADOS[nuevo]
            fila["proximo_seguimiento"] = tracker.proximo(nuevo)
        if "revisada" in datos:
            fila["revisada"] = "si" if datos["revisada"] else ""
            if tracker.clave_estado(fila["estado"]) in tracker.SIN_ENVIAR:
                fila["estado"] = tracker.ESTADOS["pendiente_envio" if datos["revisada"] else "preparada"]
        if datos.get("nota"):
            fila["notas"] = (fila["notas"] + f" | {date.today()}: {datos['nota'].strip()}").strip(" |")
        tracker.guardar(filas)
    if "estudiado" in datos:
        p = progreso()
        p[id_] = sorted(set(int(i) for i in datos["estudiado"]))
        PROGRESO.write_text(json.dumps(p), encoding="utf-8")
    return jsonify(serializar(fila))


# ---------------------------------------------------------------- correo

def mensaje_de(fila, datos):
    carpeta = carpeta_de(fila)
    archivo = carpeta / "correo.json"
    correo = json.loads(archivo.read_text(encoding="utf-8")) if archivo.exists() else {
        "asunto": f"Postulación {fila['puesto']} – {NOMBRE}"}
    cuerpo = datos.get("cuerpo") or leer_texto(carpeta / correo.get("cuerpo", "carta.md"))
    adjuntos = [RAIZ / a for a in correo.get("adjuntos", [])] or list(carpeta.glob("*.pdf"))
    para = datos.get("para") or correo.get("para")
    if not para:
        raise ValueError("Falta el mail del destinatario.")
    asunto = datos.get("asunto") or correo["asunto"]
    return enviar_correo.armar_mensaje(para, asunto, cuerpo, adjuntos), para, adjuntos


@app.post("/api/postulaciones/<id_>/enviar")
def enviar(id_):
    datos = request.get_json(force=True)
    if datos.get("confirmo") is not True:
        return jsonify(error="Falta confirmar que revisaste el mail."), 400
    fila = next((f for f in tracker.leer() if f["id"] == id_), None)
    if not fila or not carpeta_de(fila):
        return jsonify(error="Esta postulación no tiene un mail preparado."), 404
    try:
        msg, para, _ = mensaje_de(fila, datos)
        enviar_correo.enviar(msg)
    except (ValueError, RuntimeError, OSError) as e:
        return jsonify(error=str(e)), 400
    with cerrojo_csv:
        filas = tracker.leer()
        for f in filas:
            if f["id"] == id_:
                if tracker.clave_estado(f["estado"]) in tracker.SIN_ENVIAR:
                    f["fecha"] = date.today().isoformat()
                f["estado"] = tracker.ESTADOS["enviado"]
                f["proximo_seguimiento"] = tracker.proximo("enviado")
                f["notas"] = (f["notas"] + f" | {date.today()}: mail enviado a {para}").strip(" |")
        tracker.guardar(filas)
    return jsonify(ok=True)


# ---------------------------------------------------------------- ofertas nuevas (asistente)

def binario_asistente():
    if os.environ.get("ASISTENTE_BIN"):
        return os.environ["ASISTENTE_BIN"]
    if shutil.which("claude"):
        return shutil.which("claude")
    # El que trae la app de escritorio (la ruta cambia con cada versión).
    candidatos = glob(str(Path.home() / ".config/Claude/claude-code/*/*/claude"))
    return max(candidatos, key=os.path.getmtime) if candidatos else None


HERRAMIENTAS_PERMITIDAS = [
    "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "Task", "TodoWrite",
    "Bash(python3 herramientas/generar_cv.py:*)",
    "Bash(python3 herramientas/verificar_ats.py:*)",
    "Bash(python3 herramientas/tracker.py:*)",
    "Bash(mkdir:*)", "Bash(ls:*)", "Bash(pdftotext:*)", "Bash(pdfinfo:*)", "Bash(wc:*)", "Bash(head:*)", "Bash(cat:*)",
]


def armar_prompt(carpeta, tiene_texto, imagenes, link):
    rel = carpeta.relative_to(RAIZ).as_posix()
    partes = []
    if tiene_texto:
        partes.append(f"el texto pegado en `{rel}/oferta.txt`")
    if imagenes:
        partes.append("las capturas " + ", ".join(f"`{rel}/{i}`" for i in imagenes) + " (leelas con Read)")
    if link:
        partes.append(f"el link {link}")
    return f"""Procesá una oferta laboral nueva para {APODO} ({NOMBRE}) siguiendo al pie de la letra REGLAS.md y `asistente/postular.md`.

La oferta está en: {', y '.join(partes)}.

Reglas de esta corrida automática (la lanzó la plataforma web, nadie puede contestarte):
- No hagas preguntas. Si falta un dato, elegí la opción más conservadora y anotalo en analisis.md.
- Corré los scripts con `python3 herramientas/...` desde la raíz del proyecto (el entorno ya está activo).
- Cada comando de Bash va solo: sin `&&`, `;`, variables, `cd` ni heredocs (si no, se bloquea). Para crear o cambiar archivos usá Write/Edit, no Bash.
- NUNCA envíes correos ni corras enviar_correo.py.
- Si el canal es email, al final escribí `<carpeta de la postulación>/correo.json` con este formato:
  {{"para": "<mail>", "asunto": "<asunto que pide la oferta>", "cuerpo": "carta.md", "adjuntos": ["postulaciones/<carpeta>/<pdf>"]}}
- Si la oferta cae en `descartar_si`, no generes nada y respondé sólo: `DESCARTADA: <motivo en una oración>`.
- Si se generó, terminá tu respuesta con una línea: `RESULTADO: postulaciones/<carpeta>` y otra `RESUMEN: <2 oraciones para {APODO}, hablándole de vos>`.
"""


REGLAS_AUTOMATICAS = f"""Reglas de esta corrida automática (la lanzó la plataforma web, nadie puede contestarte):
- No hagas preguntas. Si falta un dato, elegí la opción más conservadora.
- Corré los scripts con `python3 herramientas/...` desde la raíz del proyecto (el entorno ya está activo).
- Cada comando de Bash va solo: sin `&&`, `;`, variables, `cd` ni heredocs. Para crear o cambiar archivos usá Write/Edit.
- NUNCA envíes correos ni corras enviar_correo.py.
- Terminá con una línea `RESUMEN: <1-2 oraciones para {APODO}, hablándole de vos>`."""


def prompt_actualizar_cv(fila):
    carpeta = carpeta_de(fila).relative_to(RAIZ).as_posix()
    return f"""{APODO} sumó conocimientos nuevos en `perfil/conocimientos.yaml`. Actualizá su postulación a "{fila['puesto']}" en {fila['empresa']}, que está en `{carpeta}/`.

1. Leé REGLAS.md, `{carpeta}/oferta.md`, `{carpeta}/analisis.md`, `{carpeta}/cv.yaml`, `perfil/cv_maestro.yaml` y `perfil/conocimientos.yaml`.
2. Sumá a `{carpeta}/cv.yaml` los conocimientos nuevos que sirvan para este puesto (certificados en Formación; lo que ya sabía en habilidades, perfil o en el logro donde encaje). Si un conocimiento coincide con una de las `## Palabras clave` del análisis, escribila **con las mismas palabras exactas** para que el ATS la encuentre. No inventes nada más.
3. Regenerá el PDF con el mismo nombre que ya tiene (`python3 herramientas/generar_cv.py {carpeta}/cv.yaml {carpeta}/<pdf existente>`) y corré `verificar_ats.py` con las palabras clave del análisis.
4. Actualizá en `{carpeta}/analisis.md` las brechas que ya no son brechas y ajustá el puntaje si corresponde.
5. Si la carta conviene mencionarlo, actualizá `{carpeta}/carta.md`.

{REGLAS_AUTOMATICAS}
"""


def prompt_plan():
    return f"""Recalculá el plan de estudio de {APODO} en `perfil/plan_estudio.json` siguiendo la sección "Plan de estudio" de REGLAS.md.

Fuentes: `seguimiento.csv` (columnas requisitos_clave, para_estudiar, puntaje_match, estado), los `analisis.md` de cada carpeta en `postulaciones/`, y `perfil/conocimientos.yaml` (lo que ya sabe no va en el plan; si un item existente ya está cubierto, marcalo `certificado`).
Agrupá temas parecidos aunque estén escritos distinto, ordená por prioridad y conservá el `estado` de los items que ya existían. Para cada item poné un recurso gratis concreto.

{REGLAS_AUTOMATICAS}
"""


def describir_paso(bloque):
    """Convierte un paso del asistente en un texto legible para la interfaz."""
    nombre, entrada = bloque.get("name", ""), bloque.get("input", {}) or {}
    if nombre == "Bash":
        cmd = entrada.get("command", "")
        for clave, texto in (("generar_cv", "Generando el PDF del CV"), ("verificar_ats", "Chequeando filtros ATS"),
                             ("tracker.py agregar", "Registrando en el seguimiento"), ("tracker.py", "Actualizando el seguimiento")):
            if clave in cmd:
                return texto
        if cmd.startswith("mkdir"):
            return "Creando la carpeta de la postulación"
        return "Revisando archivos del proyecto"
    if nombre == "Read":
        archivo = Path(entrada.get("file_path", "")).name
        return "Leyendo la captura" if archivo.startswith("captura") else f"Leyendo {archivo}"
    if nombre in ("Write", "Edit"):
        archivo = Path(entrada.get("file_path", "")).name
        return {"cv.yaml": "Adaptando el CV al puesto", "carta.md": "Escribiendo la carta de presentación",
                "analisis.md": "Analizando requisitos y brechas", "oferta.md": "Guardando la oferta",
                "correo.json": "Preparando el mail", "plan_estudio.json": "Actualizando el plan de estudio",
                "cursos.json": "Guardando el curso", "diccionario.json": "Completando el diccionario"}.get(archivo, f"Escribiendo {archivo}")
    if nombre in ("WebFetch", "WebSearch"):
        return "Investigando en internet"
    if nombre in ("Agent", "Task"):
        return "Revisión independiente: que el CV no invente nada"
    return None


def guardar_estado(carpeta, **cambios):
    archivo = carpeta / "estado.json"
    estado = json.loads(archivo.read_text(encoding="utf-8")) if archivo.exists() else {}
    estado.update(cambios)
    archivo.write_text(json.dumps(estado, ensure_ascii=False, indent=1), encoding="utf-8")
    return estado


def procesar(carpeta, prompt, tipo="oferta", postulacion=None):
    # Se guarda todo lo necesario para poder reintentar si se corta.
    guardar_estado(carpeta, prompt=prompt, tipo=tipo, postulacion=postulacion)
    with (cola_fondo if tipo in TIPOS_DE_FONDO else cola):
        guardar_estado(carpeta, estado="procesando", inicio=time.time(), pasos=[])
        binario = binario_asistente()
        if not binario:
            guardar_estado(carpeta, estado="error", fin=time.time(),
                           mensaje="No encontré el asistente. Instalalo o definí ASISTENTE_BIN.")
            return
        ids_antes = {f["id"] for f in tracker.leer()}
        entorno = {**os.environ, "PATH": f"{RAIZ / '.venv' / 'bin'}{os.pathsep}{os.environ.get('PATH', '')}"}
        modelo = leer_json(CONFIG, {}).get("modelos", {}).get(tipo) or MODELOS.get(tipo, "sonnet")
        # Sin subagentes: cada uno arranca de cero y multiplica el gasto.
        herramientas = [h for h in HERRAMIENTAS_PERMITIDAS if h not in ("Agent", "Task")]
        comando = [binario, "-p", prompt, "--output-format", "stream-json", "--verbose", "--model", modelo,
                   *(["--max-turns", str(MAX_TURNOS[tipo])] if tipo in MAX_TURNOS else []),
                   "--permission-mode", "acceptEdits", "--allowedTools", *herramientas,
                   "--disallowedTools", "Bash(python3 herramientas/enviar_correo.py:*)"]
        pasos, final = [], ""
        with open(carpeta / "registro.jsonl", "w", encoding="utf-8") as registro:
            proc = subprocess.Popen(comando, cwd=RAIZ, env=entorno, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, text=True)
            for linea in proc.stdout:
                registro.write(linea)
                try:
                    evento = json.loads(linea)
                except json.JSONDecodeError:
                    continue
                if evento.get("type") == "assistant":
                    for bloque in evento.get("message", {}).get("content", []):
                        if bloque.get("type") == "tool_use":
                            paso = describir_paso(bloque)
                            if paso and (not pasos or pasos[-1] != paso):
                                pasos.append(paso)
                                guardar_estado(carpeta, pasos=pasos)
                elif evento.get("type") == "result":
                    final = evento.get("result", "") or ""
            proc.wait()

        nuevas = [f for f in tracker.leer() if f["id"] not in ids_antes]
        resumen = (re.search(r"RESUMEN:\s*(.+)", final) or [None, ""])[1].strip()
        if tipo == "cv" and postulacion:
            with cerrojo_csv:
                filas = tracker.leer()
                for f in filas:
                    if f["id"] == postulacion:
                        f["revisada"] = ""
                tracker.guardar(filas)
        if tipo == "preguntas":
            sumar_preguntas(carpeta / "preguntas.json")
        if tipo == "palabras":
            sumadas = sumar_palabras(carpeta / "palabras_nuevas.json")
            if sumadas:
                resumen = f"Sumé {sumadas} palabras nuevas al Diccionario PM. " + resumen
        if tipo != "oferta":
            exito = proc.returncode == 0 and bool(final)
            guardar_estado(carpeta, estado="listo" if exito else "error", fin=time.time(), postulacion=postulacion,
                           mensaje=resumen or (final[-400:] if final else "El asistente terminó sin respuesta."))
        elif "DESCARTADA:" in final:
            guardar_estado(carpeta, estado="descartada", fin=time.time(),
                           mensaje=final.split("DESCARTADA:", 1)[1].strip())
        elif nuevas:
            guardar_estado(carpeta, estado="listo", fin=time.time(), postulacion=nuevas[-1]["id"],
                           mensaje=resumen or f"{nuevas[-1]['puesto']} en {nuevas[-1]['empresa']}")
        else:
            guardar_estado(carpeta, estado="error", fin=time.time(),
                           mensaje=(final or "El asistente terminó sin generar la postulación.")[-400:])
    if tipo in ("plan", "curso", "oferta"):
        revisar_temas_nuevos()
    if tipo in ("palabra", "palabras"):
        completar_preguntas()


def guardar_entrada(texto, imagenes, archivo_texto):
    carpeta = ENTRADAS / (datetime.now().strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(2))
    carpeta.mkdir(parents=True)
    if texto:
        (carpeta / archivo_texto).write_text(texto, encoding="utf-8")
    nombres = []
    for i, img in enumerate(imagenes, 1):
        ext = Path(img.filename).suffix.lower()
        if ext not in (".png", ".jpg", ".jpeg", ".webp", ".gif"):
            ext = ".png"
        nombre = f"captura{i}{ext}"
        img.save(carpeta / nombre)
        nombres.append(nombre)
    return carpeta, nombres


@app.post("/api/ofertas")
def nueva_oferta():
    texto = (request.form.get("texto") or "").strip()
    link = (request.form.get("link") or "").strip()
    imagenes = [f for f in request.files.getlist("capturas") if f and f.filename]
    if not texto and not imagenes and not link:
        return jsonify(error="Pegá el texto, subí una captura o poné el link de la oferta."), 400
    if link and not re.match(r"https?://", link):
        return jsonify(error="El link tiene que empezar con http:// o https://"), 400

    carpeta, nombres = guardar_entrada(texto, imagenes, "oferta.txt")
    guardar_estado(carpeta, estado="en_cola", tipo="oferta", creado=time.time(), link=link,
                   vista=(request.form.get("titulo") or texto[:140] or link or "Captura de pantalla"), pasos=[])
    threading.Thread(target=procesar, args=(carpeta, armar_prompt(carpeta, bool(texto), nombres, link)), daemon=True).start()
    return jsonify(id=carpeta.name), 201


def lanzar(tipo, vista, prompt, postulacion=None):
    carpeta = ENTRADAS / (datetime.now().strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(2))
    carpeta.mkdir(parents=True)
    if callable(prompt):  # prompts que necesitan saber la carpeta del trabajo
        prompt = prompt(carpeta)
    guardar_estado(carpeta, estado="en_cola", tipo=tipo, creado=time.time(), vista=vista, pasos=[])
    threading.Thread(target=procesar, args=(carpeta, prompt, tipo, postulacion), daemon=True).start()
    return carpeta.name


@app.post("/api/postulaciones/<id_>/actualizar-cv")
def actualizar_cv(id_):
    fila = next((f for f in tracker.leer() if f["id"] == id_), None)
    if not fila or not carpeta_de(fila):
        abort(404)
    return jsonify(id=lanzar("cv", f"Actualizando el CV para {fila['empresa']}", prompt_actualizar_cv(fila), id_)), 201


# ---------------------------------------------------------------- conocimientos y estudio

CONOCIMIENTOS = RAIZ / "perfil" / "conocimientos.yaml"
PLAN = RAIZ / "perfil" / "plan_estudio.json"
TIPOS_CONOCIMIENTO = {"certificado": "Certificado", "curso": "Curso", "diplomado": "Diplomado", "experiencia": "Ya lo sabía"}


def leer_conocimientos():
    import yaml
    datos = yaml.safe_load(CONOCIMIENTOS.read_text(encoding="utf-8")) if CONOCIMIENTOS.exists() else None
    return (datos or {}).get("conocimientos") or []


def guardar_conocimientos(lista):
    import yaml
    cabecera = "".join(l + "\n" for l in CONOCIMIENTOS.read_text(encoding="utf-8").splitlines() if l.startswith("#")) \
        if CONOCIMIENTOS.exists() else ""
    CONOCIMIENTOS.write_text(cabecera + yaml.safe_dump({"conocimientos": lista}, allow_unicode=True, sort_keys=False),
                             encoding="utf-8")


def leer_plan():
    try:
        return json.loads(PLAN.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {"items": []}


@app.get("/api/conocimientos")
def conocimientos():
    return jsonify(conocimientos=leer_conocimientos(), tipos=TIPOS_CONOCIMIENTO)


@app.post("/api/conocimientos")
def agregar_conocimiento():
    d = request.get_json(force=True)
    tema = (d.get("tema") or "").strip()
    tipo = d.get("tipo") if d.get("tipo") in TIPOS_CONOCIMIENTO else "curso"
    if not tema:
        return jsonify(error="Escribí el nombre del curso o conocimiento."), 400
    nuevo = {"tema": tema, "tipo": tipo}
    for campo in ("institucion", "fecha", "detalle"):
        if (d.get(campo) or "").strip():
            nuevo[campo] = d[campo].strip()
    nuevo["agregado"] = date.today().isoformat()
    with cerrojo_csv:
        lista = leer_conocimientos()
        lista.append(nuevo)
        guardar_conocimientos(lista)
        if d.get("curso_id"):
            cursos = leer_json(CURSOS, {"items": []})
            for c in cursos["items"]:
                if c["id"] == d["curso_id"]:
                    c["estado"] = "terminado"
            CURSOS.write_text(json.dumps(cursos, ensure_ascii=False, indent=1), encoding="utf-8")
        if d.get("estudio_id"):
            plan = leer_plan()
            for item in plan["items"]:
                if item["id"] == d["estudio_id"]:
                    item["estado"] = "certificado"
            PLAN.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    return jsonify(conocimiento=nuevo, total=len(lista)), 201


@app.post("/api/prueba")
def armar_prueba():
    """Arma una prueba corta para confirmar que Caro sabe un tema antes de sumarlo al CV."""
    tema = (request.get_json(force=True).get("tema") or "").strip()[:200]
    if not tema:
        return jsonify(error="Falta el tema."), 400
    binario = binario_asistente()
    if not binario:
        return jsonify(error="No encontré el asistente para armar la prueba."), 500
    prompt = f"""Armá una prueba corta para comprobar si una persona realmente sabe lo básico de: «{tema}».
Contexto: es una Project Manager argentina que se postula a trabajos remotos. La prueba tiene que tener el nivel de una entrevista laboral real para Project Manager / Success Manager senior: nada de definiciones de memoria.
Cada pregunta es un caso corto de empresa (fintech, e-commerce, consultora, SaaS, etc.) en 1 o 2 oraciones (máximo 35 palabras), que termina con "¿Qué harías?" o "¿Qué conviene?".
Reglas para las opciones (muy importantes):
- Las 3 opciones son cortas (entre 6 y 12 palabras) y tienen casi la misma cantidad de palabras entre sí (diferencia máxima de 2). La correcta NO puede ser la más larga ni la más detallada.
- Las 3 tienen que ser razonables y profesionales: algo que un PM real podría elegir. Prohibido poner opciones absurdas, poco éticas o catastróficas (compartir contraseñas, ignorar al cliente, mentir, no hacer nada, culpar al equipo).
- Las incorrectas son errores sutiles: hacer lo correcto en el orden equivocado, priorizar otra cosa, escalar demasiado pronto o demasiado tarde, usar una herramienta que no corresponde.
- Mismo estilo de redacción en las 3 (mismo verbo inicial en infinitivo o primera persona), sin palabras que delaten la correcta ("priorizando", "alineando con stakeholders", "de forma proactiva").
Sólo alguien que sabe de verdad «{tema}» tiene que poder elegir bien. En español rioplatense neutro.
Respondé SOLO con JSON válido, sin texto antes ni después, con este formato:
{{"preguntas": [{{"pregunta": "...", "opciones": ["...", "...", "..."], "correcta": 0, "explicacion": "máximo 30 palabras: por qué esa es la mejor y qué falla en las otras"}}]}}
Exactamente 3 preguntas, 3 opciones cada una, "correcta" es el índice (0-2) de la opción correcta; variá la posición de la correcta. No uses herramientas."""
    try:
        r = subprocess.run([binario, "-p", prompt, "--output-format", "json", "--model", "haiku"], cwd=RAIZ, capture_output=True,
                           text=True, timeout=150)
        texto = json.loads(r.stdout).get("result", "")
        datos = json.loads(texto[texto.index("{"):texto.rindex("}") + 1])
        preguntas = [q for q in datos["preguntas"] if len(q.get("opciones", [])) == 3 and q.get("correcta") in (0, 1, 2)]
        if len(preguntas) < 2:
            raise ValueError("prueba incompleta")
    except (subprocess.TimeoutExpired, ValueError, KeyError, json.JSONDecodeError) as e:
        return jsonify(error=f"No pude armar la prueba ({e}). Probá de nuevo."), 502
    for q in preguntas:  # mezcla las opciones para que la correcta no quede siempre en el mismo lugar
        correcta = q["opciones"][q["correcta"]]
        random.shuffle(q["opciones"])
        q["correcta"] = q["opciones"].index(correcta)
    return jsonify(tema=tema, preguntas=preguntas[:3])


@app.get("/api/estudio")
def estudio():
    return jsonify(leer_plan())


@app.patch("/api/estudio/<id_>")
def actualizar_estudio(id_):
    nuevo = request.get_json(force=True).get("estado")
    if nuevo not in ("pendiente", "estudiando", "certificado"):
        return jsonify(error="Estado inválido"), 400
    with cerrojo_csv:
        plan = leer_plan()
        for item in plan["items"]:
            if item["id"] == id_:
                item["estado"] = nuevo
        PLAN.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    return jsonify(plan)


@app.post("/api/estudio/recalcular")
def recalcular_estudio():
    if not estudio_activo():
        return jsonify(error="El área de estudio está pausada."), 403
    return jsonify(id=lanzar("plan", "Recalculando el plan de estudio", prompt_plan())), 201


@app.get("/api/trabajos")
def trabajos():
    lista = []
    for archivo in sorted(ENTRADAS.glob("*/estado.json"), reverse=True)[:20]:
        estado = json.loads(archivo.read_text(encoding="utf-8"))
        estado.pop("prompt", None)
        lista.append({"id": archivo.parent.name, **estado})
    return jsonify(trabajos=lista)


NOTA_REINTENTO = """

IMPORTANTE: este es un reintento; la corrida anterior se cortó a mitad de camino. Antes de empezar, mirá si en `postulaciones/` (o en `perfil/`) ya quedaron archivos de esta misma tarea. Si existen, continuá desde donde quedaron: no dupliques carpetas, filas del seguimiento ni items, y revisá que lo que ya está hecho esté completo y correcto."""


def prompt_desde_archivos(carpeta, estado_t):
    """Para trabajos viejos que no guardaron el prompt."""
    imagenes = sorted(p.name for p in carpeta.glob("captura*"))
    link = estado_t.get("link", "")
    if estado_t.get("tipo") == "curso":
        return prompt_curso(carpeta, (carpeta / "curso.txt").exists(), imagenes, link)
    return armar_prompt(carpeta, (carpeta / "oferta.txt").exists(), imagenes, link)


@app.post("/api/trabajos/<id_>/reintentar")
def reintentar_trabajo(id_):
    carpeta = ENTRADAS / Path(id_).name
    archivo = carpeta / "estado.json"
    if not archivo.exists():
        abort(404)
    estado_t = json.loads(archivo.read_text(encoding="utf-8"))
    if estado_t.get("estado") in ("en_cola", "procesando"):
        return jsonify(error="Ya se está procesando."), 400
    prompt = estado_t.get("prompt") or prompt_desde_archivos(carpeta, estado_t)
    if NOTA_REINTENTO not in prompt:
        prompt += NOTA_REINTENTO
    guardar_estado(carpeta, estado="en_cola", oculto=False, mensaje="", pasos=[], fin=None, creado=time.time())
    threading.Thread(target=procesar, args=(carpeta, prompt, estado_t.get("tipo") or "oferta", estado_t.get("postulacion")),
                     daemon=True).start()
    return jsonify(ok=True)


@app.delete("/api/trabajos/<id_>")
def ocultar_trabajo(id_):
    archivo = ENTRADAS / Path(id_).name / "estado.json"
    if archivo.exists():
        guardar_estado(archivo.parent, oculto=True)
    return jsonify(ok=True)


DESCARTADAS = RAIZ / "perfil" / "ofertas_descartadas.json"


@app.get("/api/ofertas-encontradas")
def ofertas_encontradas():
    return jsonify(markdown=leer_texto(RAIZ / "ofertas_encontradas.md"), descartadas=leer_json(DESCARTADAS, {}))


@app.post("/api/ofertas-descartadas")
def descartar_oferta():
    """Caro descarta (o recupera) una oferta de la lista: se guarda por link."""
    d = request.get_json(force=True)
    link = (d.get("link") or "").strip()
    if not link:
        return jsonify(error="Falta el link."), 400
    with cerrojo_csv:
        lista = leer_json(DESCARTADAS, {})
        if d.get("descartar", True):
            lista[link] = {"titulo": (d.get("titulo") or "")[:200], "motivo": (d.get("motivo") or "").strip()[:300],
                           "fecha": date.today().isoformat()}
        else:
            lista.pop(link, None)
        DESCARTADAS.write_text(json.dumps(lista, ensure_ascii=False, indent=1), encoding="utf-8")
    return jsonify(descartadas=lista)


# ---------------------------------------------------------------- cursos

CURSOS = RAIZ / "perfil" / "cursos.json"
DICCIONARIO = RAIZ / "perfil" / "diccionario.json"
PROGRESO_DICCIONARIO = RAIZ / "perfil" / "diccionario_progreso.json"


def leer_json(ruta, vacio):
    try:
        return json.loads(ruta.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return vacio


def prompt_curso(carpeta, tiene_texto, imagenes, link):
    rel = carpeta.relative_to(RAIZ).as_posix()
    partes = []
    if tiene_texto:
        partes.append(f"el texto en `{rel}/curso.txt`")
    if imagenes:
        partes.append("las capturas " + ", ".join(f"`{rel}/{i}`" for i in imagenes) + " (leelas con Read)")
    if link:
        partes.append(f"el link {link} (leelo con WebFetch)")
    return f"""{APODO} ({NOMBRE}) quiere guardar un curso para hacer. Está en: {', y '.join(partes)}.

1. Averiguá nombre, plataforma o institución, link, duración, costo (gratis/pago) y si da certificado. Si no podés leer el link, usá lo que haya y poné "a confirmar".
2. Leé `perfil/plan_estudio.json`, `seguimiento.csv` (requisitos_clave y para_estudiar) y `perfil/preferencias.yaml` para saber qué piden los puestos.
3. Agregá un item al final de `items` en `perfil/cursos.json` con este formato:
   {{"id": "<slug-unico>", "nombre", "plataforma", "link", "duracion", "costo", "certificado",
    "precio": {{"gratis": true|false, "moneda": "<código ISO: ARS, USD, COP, EUR…>", "monto": <número o null>, "periodo": "único"|"mes", "cuotas": {{"cantidad": <n o null>, "monto": <valor de cada cuota>, "inicial": <pago inicial si es distinto, o null>}} o null, "detalle": "<prueba gratis, becas, ayuda financiera, etc.>"}}, "descripcion": "<2-3 oraciones simples de qué se aprende>", "para_que": "<qué puestos o requisitos le cubre, nombrando empresas del seguimiento si aplica>", "motivacion": "<1 frase motivadora hablándole de vos a {APODO}>", "prioridad": <número>, "estado": "pendiente", "agregado": "AAAA-MM-DD"}}
4. Reordená `prioridad` de todos los cursos no terminados (1 = el que más le conviene hacer primero): primero los que cubren lo que más piden los puestos y el plan de estudio; a igualdad, los más cortos y gratis.
5. La `motivacion` tiene que ser verdadera. Podés decir qué puestos o búsquedas le abre ("con esto cubrís lo que piden dos de tus postulaciones"). Sólo poné un porcentaje de aumento de sueldo o de probabilidad si encontrás un dato publicado (encuesta salarial, estudio) y citá la fuente entre paréntesis; nunca inventes cifras.

{REGLAS_AUTOMATICAS}
"""


CONFIG = RAIZ / "perfil" / "config.json"


@app.get("/api/config")
def config():
    return jsonify(leer_json(CONFIG, {}))


@app.patch("/api/config")
def actualizar_config():
    d = request.get_json(force=True)
    try:
        venta = float(str(d.get("dolar_oficial_venta")).replace(",", "."))
    except ValueError:
        return jsonify(error="Poné un número, por ejemplo 1575"), 400
    if not 100 <= venta <= 100000:
        return jsonify(error="Ese valor del dólar no parece correcto"), 400
    with cerrojo_csv:
        cfg = leer_json(CONFIG, {})
        cfg.update(dolar_oficial_venta=venta, dolar_fecha=date.today().isoformat())
        CONFIG.write_text(json.dumps(cfg, ensure_ascii=False, indent=1), encoding="utf-8")
    return jsonify(cfg)


@app.get("/api/cursos")
def cursos():
    datos = leer_json(CURSOS, {"items": []})
    datos["config"] = leer_json(CONFIG, {})
    datos["items"].sort(key=lambda c: (c.get("estado") == "terminado", c.get("prioridad") or 99))
    return jsonify(datos)


@app.post("/api/cursos")
def nuevo_curso():
    if not estudio_activo():
        return jsonify(error="El área de estudio está pausada."), 403
    texto = (request.form.get("texto") or "").strip()
    link = (request.form.get("link") or "").strip()
    imagenes = [f for f in request.files.getlist("capturas") if f and f.filename]
    if not texto and not imagenes and not link:
        return jsonify(error="Pegá el link, una descripción o una captura del curso."), 400
    if link and not re.match(r"https?://", link):
        return jsonify(error="El link tiene que empezar con http:// o https://"), 400
    carpeta, nombres = guardar_entrada(texto, imagenes, "curso.txt")
    guardar_estado(carpeta, estado="en_cola", tipo="curso", creado=time.time(), link=link,
                   vista=(texto[:120] or link or "Captura de un curso"), pasos=[])
    threading.Thread(target=procesar, args=(carpeta, prompt_curso(carpeta, bool(texto), nombres, link), "curso"),
                     daemon=True).start()
    return jsonify(id=carpeta.name), 201


@app.patch("/api/cursos/<id_>")
def actualizar_curso(id_):
    nuevo = request.get_json(force=True).get("estado")
    if nuevo not in ("pendiente", "en_curso", "terminado"):
        return jsonify(error="Estado inválido"), 400
    with cerrojo_csv:
        datos = leer_json(CURSOS, {"items": []})
        for c in datos["items"]:
            if c["id"] == id_:
                c["estado"] = nuevo
        CURSOS.write_text(json.dumps(datos, ensure_ascii=False, indent=1), encoding="utf-8")
    return cursos()


@app.delete("/api/cursos/<id_>")
def quitar_curso(id_):
    with cerrojo_csv:
        datos = leer_json(CURSOS, {"items": []})
        datos["items"] = [c for c in datos["items"] if c["id"] != id_]
        CURSOS.write_text(json.dumps(datos, ensure_ascii=False, indent=1), encoding="utf-8")
    return cursos()


# ---------------------------------------------------------------- diccionario PM

@app.get("/api/diccionario")
def diccionario():
    progreso_d = leer_json(PROGRESO_DICCIONARIO, {})
    return jsonify(palabras=leer_json(DICCIONARIO, {"palabras": []})["palabras"],
                   progreso={k: v for k, v in progreso_d.items() if k != "_juego"},
                   juego=juego_de_hoy(progreso_d))


def juego_de_hoy(progreso_d):
    j = progreso_d.get("_juego", {})
    if j.get("fecha") != date.today().isoformat():  # el día nuevo arranca de cero, la racha y el total no
        j = {**j, "fecha": date.today().isoformat(), "jugadas_hoy": 0, "aciertos_hoy": 0}
    if "jugadas_total" not in j:  # lo que jugó antes de que se guardara el total
        palabras = [v for k, v in progreso_d.items() if k != "_juego"]
        j["aciertos_total"] = sum(v.get("aciertos", 0) for v in palabras)
        j["jugadas_total"] = j["aciertos_total"] + sum(v.get("errores", 0) for v in palabras)
    return {"racha": 0, "mejor_racha": 0, **j}


@app.post("/api/diccionario/<id_>/respuesta")
def responder_palabra(id_):
    correcta = bool(request.get_json(force=True).get("correcta"))
    with cerrojo_csv:
        progreso_d = leer_json(PROGRESO_DICCIONARIO, {})
        p = progreso_d.setdefault(id_, {"caja": 0, "aciertos": 0, "errores": 0})
        if correcta:
            p["aciertos"] += 1
            p["caja"] = min(p["caja"] + 1, 5)
        else:
            p["errores"] += 1
            p["caja"] = 0
        p["ultima"] = datetime.now().isoformat(timespec="seconds")
        j = juego_de_hoy(progreso_d)
        j["jugadas_hoy"] += 1
        j["jugadas_total"] += 1
        j["aciertos_hoy"] += correcta
        j["aciertos_total"] += correcta
        j["racha"] = j["racha"] + 1 if correcta else 0
        j["mejor_racha"] = max(j["mejor_racha"], j["racha"])
        progreso_d["_juego"] = j
        PROGRESO_DICCIONARIO.write_text(json.dumps(progreso_d, ensure_ascii=False, indent=1), encoding="utf-8")
    return jsonify(palabra=p, juego=j)


def prompt_palabra(palabra):
    return f"""{APODO} ({NOMBRE}) agregó una palabra a su Diccionario PM en `perfil/diccionario.json`: id "{palabra['id']}", término "{palabra['termino']}".
Escribió: significado = "{palabra.get('significado', '')}"{f', ejemplo = "{palabra["ejemplo"]}"' if palabra.get('ejemplo') else ''}.

Completá con Edit SÓLO esa entrada, con el mismo formato que las demás:
- "pronunciacion": cómo se pronuncia escrito a la española (ej. "ínsait").
- "categoria": una de "Scrum y ágil", "Herramientas", "Negocio y clientes", "Reuniones y comunicación", "Tecnología".
- "significado": dejá lo que escribió {APODO} si es correcto (podés pulirlo a una oración de menos de 90 caracteres). Si está mal, corregilo y agregá "nota": "<qué estaba mal, explicado con cariño>".
- "criollo": cómo se diría en criollo argentino, entre comillas latinas «».
- "por_que": por qué en las empresas se usa ese término (1-2 oraciones simples).
- "ejemplo": una frase de trabajo real entre «».
- "preguntas_entrevista": lista con 2 preguntas distintas que le podrían hacer en una entrevista de PM / Success Manager y que usen el término.
Sacá el campo "completando".

{REGLAS_AUTOMATICAS}
"""


@app.post("/api/diccionario")
def agregar_palabra():
    if not estudio_activo():
        return jsonify(error="El área de estudio está pausada."), 403
    d = request.get_json(force=True)
    termino = (d.get("termino") or "").strip()
    if not termino:
        return jsonify(error="Escribí la palabra."), 400
    base = re.sub(r"[^a-z0-9]+", "-", termino.lower()).strip("-") or "palabra"
    with cerrojo_csv:
        datos = leer_json(DICCIONARIO, {"palabras": []})
        ids = {p["id"] for p in datos["palabras"]}
        if any(p["termino"].lower() == termino.lower() for p in datos["palabras"]):
            return jsonify(error=f"«{termino}» ya está en el diccionario."), 400
        id_ = base if base not in ids else f"{base}-{secrets.token_hex(2)}"
        palabra = {"id": id_, "termino": termino, "significado": (d.get("significado") or "").strip(),
                   "origen": "propia", "agregado": date.today().isoformat()}
        if (d.get("ejemplo") or "").strip():
            palabra["ejemplo"] = d["ejemplo"].strip()
        completar = d.get("completar", True) or not palabra["significado"]
        if completar:
            palabra["completando"] = True
        datos["palabras"].append(palabra)
        DICCIONARIO.write_text(json.dumps(datos, ensure_ascii=False, indent=1), encoding="utf-8")
    if completar:
        lanzar("palabra", f"Completando «{termino}» en el diccionario", prompt_palabra(palabra))
    return jsonify(palabra=palabra), 201


# ---------------------------------------------------------------- carta editable

@app.put("/api/postulaciones/<id_>/carta")
def editar_carta(id_):
    texto = (request.get_json(force=True).get("texto") or "").strip()
    if not texto:
        return jsonify(error="La carta no puede quedar vacía."), 400
    fila = next((f for f in tracker.leer() if f["id"] == id_), None)
    if not fila or not carpeta_de(fila):
        abort(404)
    (carpeta_de(fila) / "carta.md").write_text(texto + "\n", encoding="utf-8")
    return jsonify(serializar(fila))


# ---------------------------------------------------------------- CV editable

def cv_de(id_):
    fila = next((f for f in tracker.leer() if f["id"] == id_), None)
    carpeta = carpeta_de(fila) if fila else None
    if not carpeta or not (carpeta / "cv.yaml").exists():
        abort(404)
    return fila, carpeta


@app.get("/api/postulaciones/<id_>/cv")
def ver_cv(id_):
    _, carpeta = cv_de(id_)
    cv = yaml.safe_load((carpeta / "cv.yaml").read_text(encoding="utf-8"))
    d = cv.get("datos_personales", {})
    return jsonify(titular=d.get("titular", ""), perfil=cv.get("perfil", ""),
                   pretension=d.get("pretension", "") if d.get("mostrar_pretension") else "",
                   experiencia=[{"puesto": e.get("puesto", ""), "empresa": e.get("empresa", ""), "periodo": e.get("periodo", ""),
                                 "logros": e.get("logros", [])} for e in cv.get("experiencia", []) if not e.get("omitir")])


@app.put("/api/postulaciones/<id_>/cv")
def editar_cv(id_):
    fila, carpeta = cv_de(id_)
    nuevo = request.get_json(force=True)
    archivo = carpeta / "cv.yaml"
    cv = yaml.safe_load(archivo.read_text(encoding="utf-8"))
    d = cv.setdefault("datos_personales", {})
    d["titular"] = (nuevo.get("titular") or d.get("titular", "")).strip()
    cv["perfil"] = (nuevo.get("perfil") or cv.get("perfil", "")).strip()
    pretension = (nuevo.get("pretension") or "").strip()
    if pretension:
        d.update(pretension=pretension, mostrar_pretension=True)
    else:
        d["mostrar_pretension"] = False
    visibles = [e for e in cv.get("experiencia", []) if not e.get("omitir")]
    for e, cambio in zip(visibles, nuevo.get("experiencia", []), strict=False):
        for clave in ("puesto", "empresa", "periodo"):
            if (cambio.get(clave) or "").strip():
                e[clave] = cambio[clave].strip()
        e["logros"] = [l.strip() for l in cambio.get("logros", []) if l.strip()]
    if any("VERIFICAR" in x for x in generar_cv.textos(cv)):
        return jsonify(error="Hay un texto con VERIFICAR: sacalo antes de guardar."), 400
    archivo.write_text(yaml.safe_dump(cv, allow_unicode=True, sort_keys=False, width=1000), encoding="utf-8")
    pdfs = sorted(carpeta.glob("*.pdf"))
    destino = pdfs[0] if pdfs else carpeta / f"{PERSONA['archivo_cv']}.pdf"
    doc = generar_cv.SimpleDocTemplate(str(destino), pagesize=generar_cv.A4, leftMargin=16 * generar_cv.mm,
                                       rightMargin=16 * generar_cv.mm, topMargin=14 * generar_cv.mm, bottomMargin=14 * generar_cv.mm,
                                       title=f"CV {d.get('nombre', '')}", author=d.get("nombre", ""))
    doc.build(generar_cv.construir(cv))
    return jsonify(serializar(fila))


# ---------------------------------------------------------------- búsqueda diaria

REGLAS_BUSQUEDA = """- Buscá todas las familias de `puestos_objetivo` de `perfil/preferencias.yaml`.
- Fuentes: `perfil/fuentes.yaml`, rotando como dice `buscar.md`. En la línea «Fuentes:» de la sección anotá cuáles revisaste.
- No descartes ofertas por pedir título universitario (aunque sea excluyente): anotalo como brecha.
- Descartá lo que caiga en `descartar_si` de `perfil/preferencias.yaml`."""


def reglas_busqueda():
    """Reglas de búsqueda propias de cada persona (en `perfil/persona.json`, clave `reglas_busqueda`)."""
    reglas = PERSONA.get("reglas_busqueda")
    return "\n".join(f"- {r}" for r in reglas) if reglas else REGLAS_BUSQUEDA


def prompt_busqueda():
    hoy = date.today().isoformat()
    mes_anterior = (date.today().replace(day=1) - timedelta(days=1)).replace(day=1)
    desde = mes_anterior.strftime("%d/%m/%Y")
    return f"""Hacé la búsqueda diaria de ofertas para {APODO} ({NOMBRE}) siguiendo REGLAS.md y `asistente/buscar.md` al pie de la letra.

- Sólo fuentes públicas, sin iniciar sesión en ningún sitio. Todo el mundo, sólo 100% remoto.
{reglas_busqueda()}
- No vuelvas a listar las ofertas cuyo link esté en `perfil/ofertas_descartadas.json` (las descartó {APODO}).
- Ventana de fechas: ofertas publicadas en {desde} o después (este mes y el mes anterior), no sólo las de hoy o esta semana. Usá los filtros de fecha de cada portal en «último mes» o el más amplio que haya. Si siguen abiertas, entran aunque tengan semanas. Priorizá las que se postulan por mail o formulario.
- Agregá arriba de `ofertas_encontradas.md` (debajo del título) una sección `## Búsqueda diaria del {hoy}` con la tabla de siempre (incluí la columna salario: el publicado, o "no dice"). En la columna de brechas, si cumple todos los requisitos no inventes brechas: poné «¡Cumplís con todo, postulate!» (y el tip si hay). Si no aparece nada nuevo, agregá la sección igual con una línea que lo diga.
- No prepares postulaciones: sólo buscar y listar.
- Ahorro: como máximo 15 ofertas nuevas, las mejores. Para no repetir, usá Grep sobre `ofertas_encontradas.md` (link o empresa) en vez de leer el archivo entero. Usá WebSearch y abrí con WebFetch sólo los avisos que pintan bien.

{REGLAS_AUTOMATICAS}
En el RESUMEN decí cuántas ofertas nuevas encontraste y cuál es la mejor."""


def lanzar_busqueda(origen):
    with cerrojo_csv:
        cfg = leer_json(CONFIG, {})
        cfg.setdefault("busqueda_diaria", {"activa": True, "hora": "09:00"})["ultima"] = date.today().isoformat()
        CONFIG.write_text(json.dumps(cfg, ensure_ascii=False, indent=1), encoding="utf-8")
    return lanzar("busqueda", f"Buscando ofertas nuevas ({origen})", prompt_busqueda())


@app.post("/api/busqueda")
def buscar_ahora():
    if any(e.get("tipo") == "busqueda" and e.get("estado") in ("en_cola", "procesando")
           for e in (json.loads(a.read_text(encoding="utf-8")) for a in ENTRADAS.glob("*/estado.json"))):
        return jsonify(error="Ya hay una búsqueda en marcha."), 409
    return jsonify(id=lanzar_busqueda("a pedido")), 201


@app.patch("/api/busqueda")
def configurar_busqueda():
    d = request.get_json(force=True)
    with cerrojo_csv:
        cfg = leer_json(CONFIG, {})
        b = cfg.setdefault("busqueda_diaria", {"activa": True, "hora": "09:00"})
        if "activa" in d:
            b["activa"] = bool(d["activa"])
        if "hora" in d:
            if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", str(d["hora"])):
                return jsonify(error="La hora va como 09:00"), 400
            b["hora"] = d["hora"]
        CONFIG.write_text(json.dumps(cfg, ensure_ascii=False, indent=1), encoding="utf-8")
    return jsonify(cfg)


def reloj_busqueda():
    """Lanza la búsqueda una vez por día, a la hora configurada (o apenas se prende la compu si ya pasó)."""
    while True:
        b = leer_json(CONFIG, {}).get("busqueda_diaria", {"activa": True, "hora": "09:00"})
        if b.get("activa", True) and b.get("ultima") != date.today().isoformat() \
                and datetime.now().strftime("%H:%M") >= b.get("hora", "09:00"):
            lanzar_busqueda("automática del día")
        time.sleep(300)


# ---------------------------------------------------------------- diccionario que crece

TEMAS_DICCIONARIO = RAIZ / "perfil" / "diccionario_temas.json"


def temas_de_estudio():
    temas = {f"plan:{i['id']}": i.get("tema", "") for i in leer_plan().get("items", [])}
    for c in leer_json(CURSOS, {"items": []}).get("items", []):
        if c.get("id"):
            temas[f"curso:{c['id']}"] = c.get("titulo") or c.get("nombre") or c.get("descripcion", "")[:120]
    return {k: v for k, v in temas.items() if v}


def estudio_activo():
    """El área de estudio (plan, cursos, diccionario) está pausada salvo que config.json diga "estudio_activo": true."""
    return bool(leer_json(CONFIG, {}).get("estudio_activo", False))


def revisar_temas_nuevos():
    """Por cada tema nuevo para estudiar, suma 50 palabras al diccionario."""
    if not estudio_activo():
        return
    with cerrojo_csv:
        temas = temas_de_estudio()
        if not TEMAS_DICCIONARIO.exists():  # la primera vez, lo que ya está no dispara nada
            TEMAS_DICCIONARIO.write_text(json.dumps({"cubiertos": sorted(temas)}, ensure_ascii=False, indent=1), encoding="utf-8")
            return
        registro = leer_json(TEMAS_DICCIONARIO, {"cubiertos": []})
        nuevos = {k: v for k, v in temas.items() if k not in registro["cubiertos"]}
        registro["cubiertos"] = sorted(set(registro["cubiertos"]) | set(nuevos))
        TEMAS_DICCIONARIO.write_text(json.dumps(registro, ensure_ascii=False, indent=1), encoding="utf-8")
    for tema in nuevos.values():
        lanzar("palabras", f"Sumando 50 palabras sobre «{tema[:60]}»", lambda carpeta, tema=tema: prompt_palabras_tema(carpeta, tema))


def prompt_palabras_tema(carpeta, tema):
    rel = carpeta.relative_to(RAIZ).as_posix()
    datos = leer_json(DICCIONARIO, {"palabras": []})
    categorias = sorted({p.get("categoria") for p in datos["palabras"] if p.get("categoria")})
    return f"""{APODO} ({NOMBRE}) tiene un tema nuevo para estudiar: «{tema}». Armá 50 palabras o expresiones nuevas de ese tema para su Diccionario PM (las que se escuchan en entrevistas y en el trabajo de un PM / Success Manager remoto en empresas de habla hispana).

1. Leé `perfil/diccionario.json` para ver el formato y NO repitas ningún término que ya esté.
2. Escribí con Write el archivo `{rel}/palabras_nuevas.json`: una lista JSON de 50 objetos, cada uno con:
   "termino", "pronunciacion" (a la española, ej. "ínsait"), "categoria" (una de: {', '.join(categorias)}),
   "significado" (menos de 90 caracteres), "criollo" (entre «»), "por_que" (1-2 oraciones), "ejemplo" (frase de trabajo entre «»),
   y "preguntas_entrevista": lista con 2 preguntas distintas de entrevista que usen el término.
3. Nada inventado: definiciones correctas y de uso real. Usá comillas tipográficas ‘ ’ adentro de los textos para no romper el JSON.
No toques `perfil/diccionario.json`: la plataforma suma el archivo sola.

{REGLAS_AUTOMATICAS}"""


def faltan_preguntas():
    return [p for p in leer_json(DICCIONARIO, {"palabras": []})["palabras"]
            if p.get("significado") and len(p.get("preguntas_entrevista") or []) < 2]


def prompt_preguntas(carpeta, palabras):
    rel = carpeta.relative_to(RAIZ).as_posix()
    lista = "\n".join(f'- {p["id"]}: {p["termino"]} ({p["significado"]})' for p in palabras)
    return f"""Para el Diccionario PM de {APODO} ({NOMBRE}), escribí 2 preguntas de entrevista laboral por cada palabra de esta lista.
Cada pregunta tiene que usar el término tal cual, en español, como la haría un recruiter o un líder en una entrevista para Project Manager / Success Manager remoto. Las dos preguntas de cada palabra tienen que ser distintas (por ejemplo, una de experiencia y una de situación).

{lista}

Escribí con Write el archivo `{rel}/preguntas.json`: un objeto JSON {{"<id>": ["pregunta 1", "pregunta 2"], ...}} con todos los ids de la lista. Usá comillas tipográficas ‘ ’ adentro de los textos para no romper el JSON.
No toques `perfil/diccionario.json`: la plataforma suma el archivo sola.

{REGLAS_AUTOMATICAS}"""


def completar_preguntas():
    """Lanza tandas de 120 palabras a las que les faltan las 2 preguntas de entrevista."""
    if not estudio_activo():
        return
    if any(e.get("tipo") == "preguntas" and e.get("estado") in ("en_cola", "procesando")
           for e in (leer_json(a, {}) for a in ENTRADAS.glob("*/estado.json"))):
        return
    faltan = faltan_preguntas()
    for i in range(0, len(faltan), 120):
        tanda = faltan[i:i + 120]
        lanzar("preguntas", "Preguntas de entrevista para el diccionario", lambda carpeta, tanda=tanda: prompt_preguntas(carpeta, tanda))


def sumar_preguntas(archivo):
    nuevas = leer_json(archivo, {})
    if not isinstance(nuevas, dict):
        return 0
    with cerrojo_csv:
        datos = leer_json(DICCIONARIO, {"palabras": []})
        sumadas = 0
        for p in datos["palabras"]:
            qs = nuevas.get(p["id"])
            if isinstance(qs, list) and len([q for q in qs if isinstance(q, str) and q.strip()]) >= 2:
                p["preguntas_entrevista"] = [q.strip() for q in qs if isinstance(q, str) and q.strip()][:2]
                p.pop("pregunta_entrevista", None)
                sumadas += 1
        DICCIONARIO.write_text(json.dumps(datos, ensure_ascii=False, indent=1), encoding="utf-8")
    return sumadas


def sumar_palabras(archivo):
    nuevas = leer_json(archivo, [])
    if not isinstance(nuevas, list):
        return 0
    sumadas = 0
    with cerrojo_csv:
        datos = leer_json(DICCIONARIO, {"palabras": []})
        terminos = {p["termino"].lower() for p in datos["palabras"]}
        ids = {p["id"] for p in datos["palabras"]}
        for p in nuevas:
            termino = (p.get("termino") or "").strip() if isinstance(p, dict) else ""
            if not termino or not p.get("significado") or termino.lower() in terminos:
                continue
            base = re.sub(r"[^a-z0-9]+", "-", termino.lower()).strip("-") or "palabra"
            p["id"] = base if base not in ids else f"{base}-{secrets.token_hex(2)}"
            p.update(termino=termino, origen="tema", agregado=date.today().isoformat())
            datos["palabras"].append(p)
            terminos.add(termino.lower())
            ids.add(p["id"])
            sumadas += 1
        DICCIONARIO.write_text(json.dumps(datos, ensure_ascii=False, indent=1), encoding="utf-8")
    return sumadas


# ---------------------------------------------------------------- arranque

def ip_local():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("192.168.0.1", 1))
            return s.getsockname()[0]
        except OSError:
            return "127.0.0.1"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--puerto", type=int, default=int(os.environ.get("PORT", 8765)))
    a = ap.parse_args()
    ENTRADAS.mkdir(exist_ok=True)
    # Lo que quedó a medias o en cola cuando se cortó el servidor se retoma solo.
    for archivo in sorted(ENTRADAS.glob("*/estado.json")):
        estado = json.loads(archivo.read_text(encoding="utf-8"))
        if estado.get("estado") not in ("en_cola", "procesando"):
            continue
        if not estado.get("prompt"):
            guardar_estado(archivo.parent, estado="error", fin=time.time(),
                           mensaje="Se cortó porque se reinició la plataforma. Tocá «Volver a intentarlo».")
            continue
        prompt = estado["prompt"] + (NOTA_REINTENTO if estado["estado"] == "procesando" and NOTA_REINTENTO not in estado["prompt"] else "")
        guardar_estado(archivo.parent, estado="en_cola", pasos=[])
        threading.Thread(target=procesar, args=(archivo.parent, prompt, estado.get("tipo", "oferta"), estado.get("postulacion")),
                         daemon=True).start()
    revisar_temas_nuevos()
    completar_preguntas()
    threading.Thread(target=reloj_busqueda, daemon=True).start()
    print(f"\n  Plataforma de postulaciones de {APODO}")
    print(f"  En esta compu:   http://localhost:{a.puerto}")
    print(f"  En el celular:   http://{ip_local()}:{a.puerto}   (mismo Wi-Fi)")
    print(f"  Clave de acceso: {clave_panel()}\n")
    app.run(host="0.0.0.0", port=a.puerto, threaded=True, debug=False)


if __name__ == "__main__":
    main()
