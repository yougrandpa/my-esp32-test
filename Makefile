PYTHON ?= python3
PIO := .venv/bin/pio
PORT ?=
HTTP_PORT ?= 8000
NODE ?= node
CXX ?= c++
PORT_ARG = $(if $(PORT),--port $(PORT),)
UPLOAD_PORT_ARG = $(if $(PORT),--upload-port $(PORT),)
WEB_SOURCES := esp32_led_control.html $(wildcard web/*.mjs) web/styles.css scripts/embed_web.py

.PHONY: help setup build upload monitor ports serve web-assets test clean

help:
	@printf '%s\n' 'make web-assets  更新 Arduino IDE / 固件使用的网页资源头文件'
	@printf '%s\n' 'make setup    安装本地 PlatformIO 环境' 'make build    编译 ESP32 固件' 'make ports    列出串口' 'make upload   烧录固件（可选 PORT=/dev/cu.xxx）' 'make monitor  串口监视器（可选 PORT=/dev/cu.xxx）' 'make serve    启动网页：http://localhost:8000/esp32_led_control.html' 'make test     运行灯效、协议和收藏测试（需 Node.js 18+ / C++17 编译器）' 'make clean    清理固件构建产物'

$(PIO): requirements-dev.txt
	$(PYTHON) -m venv .venv
	.venv/bin/python -m pip install -r requirements-dev.txt
	@touch $(PIO)

setup: $(PIO)

build: $(PIO)
	$(PIO) run

upload: $(PIO)
	$(PIO) run --target upload $(UPLOAD_PORT_ARG)

monitor: $(PIO)
	$(PIO) device monitor $(PORT_ARG)

ports: $(PIO)
	$(PIO) device list

serve:
	$(PYTHON) -m http.server $(HTTP_PORT) --bind 127.0.0.1

web-assets:
	$(PYTHON) scripts/embed_web.py

esp32_led_control/web_assets.h: $(WEB_SOURCES)
	$(PYTHON) scripts/embed_web.py

test: esp32_led_control/web_assets.h
	$(NODE) --test tests/web.test.mjs
	@set -e; test_binary=$$(mktemp /tmp/esp32-led-test.XXXXXX); trap 'rm -f "$$test_binary"' EXIT; $(CXX) -std=c++17 -pthread -Wall -Wextra -I tests tests/firmware.cpp -o "$$test_binary"; "$$test_binary"

clean: $(PIO)
	$(PIO) run --target clean
