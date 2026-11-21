def test_normalizar_saca_tildes_y_mayusculas(modulos):
    assert modulos["verificar_ats"].normalizar("Gestión de RIESGOS") == "gestion de riesgos"


def test_lee_las_palabras_clave_del_analisis(modulos):
    analisis = "# Análisis\n\n## Palabras clave\nScrum, Jira; gestión de riesgos, scrum\n\n## Otra sección\nnada"
    assert modulos["servidor"].palabras_clave(analisis) == ["Scrum", "Jira", "gestión de riesgos"]


def test_sin_seccion_de_palabras_clave_no_hay_chequeo(modulos):
    assert modulos["servidor"].palabras_clave("# Análisis sin claves") == []


def test_mide_la_cobertura_contra_el_pdf(modulos, demo):
    servidor = modulos["servidor"]
    carpeta = next((demo / "postulaciones").glob("*nubra-software*"))
    ats = servidor.chequeo_ats(carpeta, (carpeta / "analisis.md").read_text(encoding="utf-8"))
    assert ats["total"] == 10
    assert ats["cobertura"] == round(100 * len(ats["presentes"]) / ats["total"])
    assert "Scrum" in ats["presentes"]
    assert set(ats["presentes"]).isdisjoint(ats["faltan"])
