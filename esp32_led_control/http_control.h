#pragma once
#include <WebServer.h>
#include <atomic>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include "web_assets.h"

class HttpControl {
 public:
  WebServer server{80};
  bool running = false;
  TaskHandle_t task = nullptr;
  std::atomic<bool> enabled{false};
  enum class Exchange { idle, pending, ready };
  std::atomic<Exchange> exchange{Exchange::idle};
  char requestCommand[256] = {};
  char response[1200];
  int responseCode = 200;

  void json(int code, const char* body) {
    server.sendHeader("Cache-Control", "no-store");
    server.send(code, "application/json; charset=utf-8", body);
  }
  void status() {
    dispatch("");
  }
  // Only the HTTP task calls dispatch. Release/acquire hands ownership of the
  // fixed buffers to loop(), then back; no lock is held during network I/O.
  void dispatch(const char* command) {
    snprintf(requestCommand, sizeof(requestCommand), "%s", command);
    exchange.store(Exchange::pending, std::memory_order_release);
    while (exchange.load(std::memory_order_acquire) != Exchange::ready) vTaskDelay(1);
    json(responseCode, response);
    exchange.store(Exchange::idle, std::memory_order_release);
  }
  void command() {
    // The board UI uses same-origin HTTP; do not accept forms from other sites.
    const auto origin = server.header("Origin");
    if (origin.length() && origin != String("http://") + server.hostHeader()) {
      json(403, "{\"error\":\"cross-origin command rejected\"}");
      return;
    }
    if (!server.hasArg("command") || server.args() != 1) {
      json(400, "{\"error\":\"one command is required\"}");
      return;
    }
    const auto value = server.arg("command");
    if (!value.length() || value.length() >= 256) { json(400, "{\"error\":\"invalid command length\"}"); return; }
    dispatch(value.c_str());
  }
  // Called exclusively by loop(): effect, PWM and Network stay on one task.
  void prepareResponse() {
    char reply[64], statusOutput[1024];
    const bool command = requestCommand[0] != 0;
    responseCode = 200;
    if (command && !executeEffectCommand(requestCommand, reply, sizeof(reply))) {
      responseCode = 400;
      snprintf(response, sizeof(response), "{\"error\":\"invalid LED command; Wi-Fi provisioning requires USB\"}");
      return;
    }
    if (!formatStatus(statusOutput, sizeof(statusOutput))) {
      responseCode = 500;
      snprintf(response, sizeof(response), "{\"error\":\"status overflow\"}");
      return;
    }
    if (!command) { snprintf(response, sizeof(response), "%s", statusOutput); return; }
    JsonBuffer output(response, sizeof(response));
    output.add("{\"ok\":true,\"reply\":");
    output.string(reply);
    output.add(",\"status\":%s}", statusOutput);
    if (!output.valid) {
      responseCode = 500;
      snprintf(response, sizeof(response), "{\"error\":\"response overflow\"}");
    }
  }
  void begin() {
    const char* headers[] = {"Origin"};
    server.collectHeaders(headers, 1);
    server.on("/api/status", HTTP_GET, [this]() { status(); });
    server.on("/api/command", HTTP_POST, [this]() { command(); });
    for (const auto& entry : WEB_ASSETS) {
      const auto* asset = &entry;
      server.on(asset->path, HTTP_GET, [this, asset]() {
        server.sendHeader("Content-Encoding", "gzip");
        server.sendHeader("Cache-Control", "no-store");
        server.send_P(200, asset->mime, (const char*)asset->data, asset->size);
      });
    }
    server.on("/", HTTP_GET, [this]() {
      const auto& page = WEB_ASSETS[0];
      server.sendHeader("Content-Encoding", "gzip");
      server.sendHeader("Cache-Control", "no-store");
      server.send_P(200, page.mime, (const char*)page.data, page.size);
    });
    server.onNotFound([this]() { json(404, "{\"error\":\"not found\"}"); });
    if (xTaskCreate([](void* context) {
      auto* control = static_cast<HttpControl*>(context);
      for (;;) { control->service(); vTaskDelay(1); }
    }, "led-http", 8192, this, 1, &task) != pdPASS) {
      task = nullptr;
      Serial.println("ERR HTTP task could not start");
    }
  }
  // All WebServer calls, including start/stop, belong to the HTTP task.
  void service() {
    const bool live = enabled.load(std::memory_order_acquire);
    if (live && !running) { server.begin(); running = true; }
    else if (!live && running) { server.stop(); running = false; }
    if (running) server.handleClient();
  }
  void tick() {
    enabled.store(task && network.enabled && WiFi.status() == WL_CONNECTED, std::memory_order_release);
    if (exchange.load(std::memory_order_acquire) == Exchange::pending) {
      prepareResponse();
      exchange.store(Exchange::ready, std::memory_order_release);
    }
  }
};

HttpControl httpControl;
