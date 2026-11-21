from datetime import date

import pytest


@pytest.fixture
def cliente(modulos, demo):
    servidor = modulos["servidor"]
    c = servidor.app.test_client()
    c.set_cookie(servidor.COOKIE, servidor.clave_panel())
    return c


def fila(modulos, id_):
    return next(f for f in modulos["tracker"].leer() if f["id"] == id_)


def test_sin_clave_no_se_ve_nada(modulos, demo):
    anonimo = modulos["servidor"].app.test_client()
    assert anonimo.get("/api/postulaciones").status_code == 401
    assert anonimo.get("/").headers["Location"].endswith("/login")
    assert anonimo.post("/login", data={"clave": "000000"}).status_code == 200  # vuelve al formulario


def test_con_la_clave_correcta_entra(modulos, demo):
    servidor = modulos["servidor"]
    anonimo = servidor.app.test_client()
    r = anonimo.post("/login", data={"clave": servidor.clave_panel()})
    assert r.status_code == 302
    assert anonimo.get("/api/postulaciones").status_code == 200


def test_lista_las_postulaciones_con_todo_lo_que_usa_la_pantalla(cliente):
    d = cliente.get("/api/postulaciones").get_json()
    assert len(d["postulaciones"]) == 9
    assert d["postulaciones"][0]["id"] == "9"  # la más nueva primero
    nubra = next(p for p in d["postulaciones"] if p["empresa"] == "Nubra Software")
    assert nubra["estado_clave"] == "entrevista"
    assert nubra["enviada"] is True
    assert nubra["ats"]["total"] == 10
    assert nubra["correo"]["para"] == "talento@nubra.example"
    assert d["persona"] == {"apodo": "Caro"}


def test_marcar_revisada_la_deja_lista_para_enviar(cliente, modulos):
    cliente.patch("/api/postulaciones/7", json={"revisada": True})
    assert fila(modulos, "7")["estado"] == modulos["tracker"].ESTADOS["pendiente_envio"]
    cliente.patch("/api/postulaciones/7", json={"revisada": False})
    assert fila(modulos, "7")["estado"] == modulos["tracker"].ESTADOS["preparada"]


def test_cambiar_estado_y_dejar_una_nota(cliente, modulos):
    r = cliente.patch("/api/postulaciones/8", json={"estado": "enviado", "nota": "formulario completo"})
    assert r.status_code == 200
    f = fila(modulos, "8")
    assert f["estado"] == modulos["tracker"].ESTADOS["enviado"]
    assert f["fecha"] == date.today().isoformat()
    assert f["notas"].endswith("formulario completo")


def test_no_envia_un_mail_sin_confirmar_que_se_reviso(cliente, modulos):
    r = cliente.post("/api/postulaciones/7/enviar", json={})
    assert r.status_code == 400
    assert "revisaste" in r.get_json()["error"]
    assert fila(modulos, "7")["estado"] == modulos["tracker"].ESTADOS["preparada"]


def test_sin_correo_configurado_no_envia_ni_cambia_el_estado(cliente, modulos, monkeypatch):
    for variable in ("SMTP_USUARIO", "SMTP_CLAVE"):
        monkeypatch.delenv(variable, raising=False)
    r = cliente.post("/api/postulaciones/7/enviar", json={"confirmo": True})
    assert r.status_code == 400
    assert "SMTP" in r.get_json()["error"]
    assert fila(modulos, "7")["estado"] == modulos["tracker"].ESTADOS["preparada"]


def test_envia_y_lo_anota_en_el_seguimiento(cliente, modulos, monkeypatch):
    enviados = []
    monkeypatch.setattr(modulos["enviar_correo"], "enviar", enviados.append)
    r = cliente.post("/api/postulaciones/7/enviar", json={"confirmo": True})
    assert r.status_code == 200
    (msg,) = enviados
    assert msg["To"] == "hola@pampa.example"
    assert "Carolina Méndez" in msg.get_body().get_content()  # la firma se agrega sola
    assert [a.get_filename() for a in msg.iter_attachments()] == ["CV_Carolina_Mendez_Agencia_Pampa.pdf"]
    f = fila(modulos, "7")
    assert f["estado"] == modulos["tracker"].ESTADOS["enviado"]
    assert "mail enviado a hola@pampa.example" in f["notas"]


def test_solo_sirve_archivos_de_las_postulaciones(cliente):
    assert cliente.get("/archivos/perfil/cv_maestro.yaml").status_code == 404
    assert cliente.get("/archivos/postulaciones/../perfil/cv_maestro.yaml").status_code == 404
    d = cliente.get("/api/postulaciones").get_json()
    pdf = next(p for p in d["postulaciones"] if p["pdfs"])["pdfs"][0]
    r = cliente.get(f"/archivos/{pdf}")
    assert r.status_code == 200
    assert r.data.startswith(b"%PDF")


def test_la_carta_no_puede_quedar_vacia(cliente):
    assert cliente.put("/api/postulaciones/7/carta", json={"texto": "  "}).status_code == 400
    r = cliente.put("/api/postulaciones/7/carta", json={"texto": "Hola:\n\nCarta nueva.\n\nSaludos cordiales,"})
    assert r.get_json()["carta_texto"].startswith("Hola:")


def test_editar_el_cv_rechaza_lo_que_dice_verificar(cliente):
    cv = cliente.get("/api/postulaciones/7/cv").get_json()
    r = cliente.put("/api/postulaciones/7/cv", json={**cv, "perfil": "Project Manager con VERIFICAR años"})
    assert r.status_code == 400
    r = cliente.put("/api/postulaciones/7/cv", json={**cv, "titular": "Project Manager Web y eCommerce"})
    assert r.status_code == 200
    assert cliente.get("/api/postulaciones/7/cv").get_json()["titular"] == "Project Manager Web y eCommerce"


def test_una_oferta_nueva_necesita_texto_captura_o_link(cliente):
    assert cliente.post("/api/ofertas", data={}).status_code == 400
    r = cliente.post("/api/ofertas", data={"link": "ftp://algo"})
    assert r.status_code == 400


def test_el_asistente_nunca_puede_enviar_mails(modulos, demo):
    servidor = modulos["servidor"]
    prompt = servidor.armar_prompt(demo / "entradas", True, [], "")
    assert "NUNCA envíes correos" in prompt
    assert not any("enviar_correo" in h for h in servidor.HERRAMIENTAS_PERMITIDAS)


def test_ofertas_encontradas(cliente):
    d = cliente.get("/api/ofertas-encontradas").get_json()
    assert "Agencia Pampa" in d["markdown"]
    r = cliente.post("/api/ofertas-descartadas", json={"link": "https://telar.example/carreras/delivery", "motivo": "ITIL"})
    assert "https://telar.example/carreras/delivery" in r.get_json()["descartadas"]
