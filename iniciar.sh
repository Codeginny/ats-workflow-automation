#!/usr/bin/env bash
# Arranca la plataforma web. La primera vez crea el entorno e instala todo.
set -e
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "Instalando por única vez…"
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi
.venv/bin/python plataforma/servidor.py "$@"
