import sys

import pytest
import yaml


def test_el_pdf_no_se_genera_si_hay_algo_para_verificar(modulos, tmp_path, monkeypatch, raiz):
    cv = yaml.safe_load((raiz / "perfil" / "cv_maestro.yaml").read_text(encoding="utf-8"))
    cv["perfil"] = "Project Manager con VERIFICAR años de experiencia."
    origen = tmp_path / "cv.yaml"
    origen.write_text(yaml.safe_dump(cv, allow_unicode=True), encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["generar_cv.py", str(origen), str(tmp_path / "cv.pdf")])
    with pytest.raises(SystemExit) as salida:
        modulos["generar_cv"].main()
    assert salida.value.code == 1
    assert not (tmp_path / "cv.pdf").exists()


def test_las_notas_internas_del_maestro_no_cuentan_como_texto_del_cv(modulos, raiz):
    maestro = yaml.safe_load((raiz / "perfil" / "cv_maestro.yaml").read_text(encoding="utf-8"))
    textos = list(modulos["generar_cv"].textos(maestro))
    assert not any("VERIFICAR" in t for t in textos)
    assert not any(t in textos for t in maestro["pendientes_de_verificar"])


def test_los_cv_de_ejemplo_no_inventan_logros(demo):
    """Cero invención: cada logro de un CV adaptado está, palabra por palabra, en el maestro."""
    maestro = yaml.safe_load((demo / "perfil" / "cv_maestro.yaml").read_text(encoding="utf-8"))
    del_maestro = {logro for exp in maestro["experiencia"] for logro in exp["logros"]}
    adaptados = list((demo / "postulaciones").glob("*/cv.yaml"))
    assert len(adaptados) == 8
    for archivo in adaptados:
        cv = yaml.safe_load(archivo.read_text(encoding="utf-8"))
        assert "pendientes_de_verificar" not in cv
        for exp in cv["experiencia"]:
            assert set(exp["logros"]) <= del_maestro, archivo.parent.name


def test_la_pretension_va_al_cv_solo_si_la_oferta_habla_de_sueldo(demo, modulos):
    for archivo in (demo / "postulaciones").glob("*/cv.yaml"):
        cv = yaml.safe_load(archivo.read_text(encoding="utf-8"))
        publica_sueldo = archivo.parent.name.split("_")[1] in ("aurea-pagos", "educaplus")
        assert bool(cv["datos_personales"].get("mostrar_pretension")) == publica_sueldo, archivo.parent.name


def test_el_pdf_tiene_texto_que_un_ats_puede_leer(demo, modulos):
    ats = modulos["verificar_ats"]
    pdf = next((demo / "postulaciones").glob("*aurea-pagos*/*.pdf"))
    texto = ats.normalizar(" ".join(ats.texto_del_pdf(pdf).split()))
    assert "carolina mendez" in texto
    assert "remuneracion pretendida" in texto
