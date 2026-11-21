from datetime import date, timedelta
from types import SimpleNamespace

import pytest


def test_los_datos_de_ejemplo_cargan_las_nueve_postulaciones(modulos, demo):
    filas = modulos["tracker"].leer()
    assert [f["id"] for f in filas] == [str(i) for i in range(1, 10)]
    assert {f["empresa"] for f in filas} >= {"Nubra Software", "Aurea Pagos", "Kora Labs"}


def test_cada_estado_tiene_su_proximo_seguimiento(modulos):
    tracker = modulos["tracker"]
    assert tracker.proximo("enviado") == (date.today() + timedelta(days=7)).isoformat()
    assert tracker.proximo("entrevista") == (date.today() + timedelta(days=2)).isoformat()
    assert tracker.proximo("rechazado") == ""


def test_acepta_la_clave_o_la_etiqueta_del_estado(modulos):
    tracker = modulos["tracker"]
    assert tracker.clave_estado("enviado") == "enviado"
    assert tracker.clave_estado(tracker.ESTADOS["entrevista"]) == "entrevista"
    assert tracker.clave_estado("🟡 Pendiente") == "enviado"  # estado de una versión anterior
    with pytest.raises(SystemExit):
        tracker.clave_estado("inventado")


def argumentos(**cambios):
    base = dict(empresa="Nubra Software", puesto="Digital Project Manager", dedica="", requisitos="", estudiar="",
                contacto="", canal="", link="", fuente="", salario="", puntaje="", carta="", cv="", notas="",
                estado="preparada", forzar=False)
    return SimpleNamespace(**{**base, **cambios})


def test_no_deja_cargar_dos_veces_la_misma_postulacion(modulos, demo):
    with pytest.raises(SystemExit, match="Ya existe"):
        modulos["tracker"].agregar(argumentos())


def test_agregar_numera_la_fila_siguiente(modulos, demo):
    tracker = modulos["tracker"]
    tracker.agregar(argumentos(empresa="Empresa Nueva", puesto="PM"))
    nueva = tracker.leer()[-1]
    assert nueva["id"] == "10"
    assert nueva["estado"] == tracker.ESTADOS["preparada"]
    assert nueva["fecha"] == date.today().isoformat()


def test_al_enviar_la_fecha_pasa_a_ser_la_del_envio(modulos, demo):
    tracker = modulos["tracker"]
    tracker.cambiar_estado(SimpleNamespace(id="7", estado="enviado", notas="mandado"))
    fila = next(f for f in tracker.leer() if f["id"] == "7")
    assert fila["fecha"] == date.today().isoformat()
    assert fila["proximo_seguimiento"] == tracker.proximo("enviado")
    assert fila["notas"].endswith("mandado")
