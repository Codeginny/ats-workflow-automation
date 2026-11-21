"""Cada test corre sobre una copia de los datos de ejemplo en una carpeta temporal,
así nada toca el seguimiento.csv ni las postulaciones del repo."""
import importlib
import os
import shutil
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent


@pytest.fixture(scope="session")
def raiz(tmp_path_factory):
    destino = tmp_path_factory.mktemp("datos")
    for carpeta in ("perfil", "demo", "herramientas"):
        shutil.copytree(REPO / carpeta, destino / carpeta, ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copy(REPO / "ofertas_encontradas.md", destino)
    os.environ["BUSCADOR_RAIZ"] = str(destino)
    os.environ["ASISTENTE_BIN"] = "false"  # si algún test lanzara el asistente, corre `false` y termina
    sys.path.insert(0, str(destino / "herramientas"))
    return destino


@pytest.fixture(scope="session")
def modulos(raiz):
    """Importa las herramientas y el servidor ya apuntando a la carpeta temporal."""
    sys.path.insert(0, str(REPO / "plataforma"))
    nombres = ("tracker", "generar_cv", "verificar_ats", "enviar_correo", "datos_demo", "servidor")
    return {n: importlib.import_module(n) for n in nombres}


@pytest.fixture
def demo(modulos, raiz):
    """Rehace las postulaciones de ejemplo antes de cada test."""
    shutil.rmtree(raiz / "postulaciones", ignore_errors=True)
    modulos["datos_demo"].main()
    return raiz
